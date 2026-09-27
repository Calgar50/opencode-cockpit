// Croisements de « 3s » (itération 3s, paquet L3s-a ; plan it3 §6 « L3s-a », §7.3 P-SALLE, §8.4 (b)) : la salle de contrôle 3D et
// « Revoir » branchés sur le VRAI code de la salle, dans `chantier/1.1` après la grande fusion (GF1 salle, GF2 3D).
// 1. Porte P-SALLE par le comportement : en Simple, une racine de la salle reçoit 403 sur /facts (L18c inchangé) ; SALLE_OUVERTE
//    reste fausse.
// 2. Q6 sur le cockpit réel (harnais à deux instances, option omo de T3b) : « Revoir » en Simple d'une demande terminée de la salle
//    → 200 ; consigne d'un enfant de la salle CAPTURÉE PAR LE PROCESSEUR DE LA SALLE (h.emitOmo) → 200 ; demande en cours → 403,
//    consigne comprise, et l'entrée disparaît du zoom 1 ; aucune ligne `usage` ; zéro requête aux deux instances pendant « Revoir » ;
//    envoi et réponse d'autorisation refusés dans les deux modes. TÉMOIN Q6 (Avancé, salle ouverte → envoi relayé) : EN ATTENTE,
//    la porte du montage /api/omo/oc/* lit la CONSTANTE SALLE_OUVERTE (http.ts, que la 3D ne modifie jamais) et le harnais n'a aucun
//    moyen de l'ouvrir ; le test qui le constate échoue le jour où un moyen existe. Jamais remplacé par le seul 403.
//    Répétition générale « 3s » : la demande de la salle est posée comme la SALLE l'écrit (ligne « omo » de conversation_autonomy,
//    par le magasin réel), jamais par une ligne `autonomy_requests` fabriquée, que la salle n'écrit pas.
// 3. P11 : les territoires lisent l'état de la salle par SON instance en Avancé, rien en Simple, jamais par le client principal ; une
//    consigne n'est jamais croisée entre les instances.
// 3 bis. Fin de la demande de la salle (salle-demande.ts) : ligne « omo », demande active du port omoActivation et dernière ligne
//    `autonomy_requests`, fermée en cas de doute (aucune demande connue, ligne illisible, port qui lève).
// 4. Enceinte : le texte du zoom 1 est le début du bandeau permanent de la salle, jusqu'à « avant exécution ».
// 5. Fixtures de la salle (omo-jp1-jp7.jsonl, omo-banc-m20/m21/r16.jsonl) : « différé = direct » du plan 3D ; P12 ; carnet dessiné
//    et libéré par le graphe three.js ; vue Simple de « Revoir » par roleDeAgent, sans nom d'agent ; légendes (tâche de fond
//    branchée, « neuf » jamais sur une reprise).
// 6. legendes-salle.ts sans texte : contrôle de source recopié de textes.test.ts (via textes-3d.test.ts), sans le modifier.
// Aucun appel facturé, aucun vrai opencode : deux faux opencode. Textes des événements : « [synthétique] ».
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { BufferGeometry, InstancedMesh, LineBasicMaterial, MeshBasicMaterial, ShaderMaterial, SpriteMaterial, Texture } from "three";
import { creerGraphe } from "../web/pages/salle-controle/three/graphe.ts";
import { ConversationAutonomyStore } from "./conversation-autonomy.ts";
import { refusMontageSalle } from "./oc-proxy.ts";
import { EventMemory, type FactContext, FactDeduper, type FactEvent, factsFromEvent, type FactSession } from "./shared/activity-facts.ts";
import type { ActivityFact, SessionInstance } from "./shared/activity-types.ts";
import { legendesAuMoment } from "./shared/legendes.ts";
import { libelleNoeud, lignesTableau } from "./shared/neon-band.ts";
import { NEON_PALETTES } from "./shared/neon-palette.ts";
import { PLAN3D_SALLE, planConversation } from "./shared/neon-plan3d.ts";
import { moments, NEON_SECTEURS, type NeonSceneOptions, scene, visibleCount } from "./shared/neon-scene.ts";
import { libelleSecteur } from "./shared/neon-texts.ts";
import { roleDeAgent } from "./shared/omo-roles.ts";
import { TEXTES as OMO_TEXTES } from "./shared/omo-room-texts.ts";
import { TEXTES as REVOIR } from "./shared/revoir-texts.ts";
import { TEXTES as SALLE3D } from "./shared/salle3d-texts.ts";
import type { Plan3d, RevoirConsigneResponse, RevoirEtatResponse, RevoirResponse, TerritoiresResponse } from "./shared/salle3d-types.ts";
import { modeSceneRevoir, nomsSimples, vueSimple } from "./shared/vue-simple.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { readCapture } from "./test-support/fake-opencode.ts";
import { SALLE_OUVERTE } from "./wiring-11.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const lire = (relatif: string): string => fs.readFileSync(path.join(APP_DIR, relatif), "utf8");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// --- Rejeu des fixtures de la salle, comme le direct (factsFromEvent puis FactDeduper) ---------------------------------------------

/**
 * Identifiant pseudonymisé des captures du banc de la salle (« [synthétique] 30 car. sha256:… », D-2b-31) : il n'a pas la forme
 * d'un identifiant d'opencode, donc aucun fait n'en sortirait. Le rejeu le remplace, de façon déterministe, par un identifiant
 * valable tiré de son empreinte ; rien d'autre n'est touché.
 */
const PSEUDONYME = /^\[synthétique\] \d+ car\. sha256:([0-9a-f]{16})$/;
function identifiants(valeur: unknown): unknown {
  if (typeof valeur === "string") {
    const trouve = PSEUDONYME.exec(valeur);
    return trouve ? `x_${trouve[1]}` : valeur;
  }
  if (Array.isArray(valeur)) return valeur.map(identifiants);
  if (isRecord(valeur)) return Object.fromEntries(Object.entries(valeur).map(([cle, v]) => [cle, identifiants(v)]));
  return valeur;
}

/** Faits d'une capture de la salle : les sessions sans parent sont des racines de l'instance `omo`. */
function rejouer(capture: string, envoyes: readonly string[] = []): ActivityFact[] {
  const sessions = new Map<string, FactSession>();
  const resolve = (id: string, info?: Readonly<Record<string, unknown>>): FactSession | null => {
    const connue = sessions.get(id);
    if (connue) return connue;
    if (info?.id !== id) return null;
    const parentId = typeof info.parentID === "string" ? info.parentID : null;
    const parent = parentId === null ? undefined : sessions.get(parentId);
    if (parentId !== null && !parent) return null;
    return { rootId: parent ? parent.rootId : id, parentId, purpose: "chat", instance: "omo" satisfies SessionInstance };
  };
  const memoire = new EventMemory();
  const dedoublonneur = new FactDeduper();
  const faits: ActivityFact[] = [];
  for (const { recv, wire } of readCapture(capture)) {
    const event = (identifiants(wire) as { payload: FactEvent }).payload;
    memoire.observe(event);
    const info = event.properties?.info;
    if ((event.type === "session.created" || event.type === "session.updated") && isRecord(info) && typeof info.id === "string") {
      const session = resolve(info.id, info);
      if (session) sessions.set(info.id, session);
    }
    const ctx: FactContext = {
      receivedAt: recv,
      session: resolve,
      messageRole: (id) => memoire.messageRole(id),
      promptKind: (id) => (envoyes.includes(id) ? "message" : null),
      firstUserMessage: (id) => memoire.firstUserMessage(id),
      userMessageParts: (id) => memoire.userMessageParts(id),
      unansweredUserMessages: (id) => memoire.unansweredUserMessages(id),
    };
    faits.push(...factsFromEvent(event, ctx).filter((fait) => dedoublonneur.accept(fait)));
  }
  return faits;
}

const OMO_FIXTURE = "omo-jp1-jp7.jsonl";
const OMO_RACINE = "ses_jp_racine";
const omoFaits = (): ActivityFact[] => rejouer(OMO_FIXTURE, ["msg_jp_demande"]);
const CAPTURES_SALLE = [OMO_FIXTURE, "omo-banc-m20.jsonl", "omo-banc-m21.jsonl", "omo-banc-r16.jsonl"] as const;

/** Faits relus comme depuis la base : data sérialisé en JSON, puis relu. */
const relus = (faits: readonly ActivityFact[]): ActivityFact[] =>
  faits.map((f, i) => ({ id: i + 1, rootId: f.rootId, sessionId: f.sessionId, kind: f.kind, ref: f.ref, data: JSON.parse(JSON.stringify(f.data)), at: f.at }));

// --- Cockpit réel à deux instances ------------------------------------------------------------------------------------------------

const lignesUsage = (h: CockpitHarness): number => (h.db.prepare("SELECT COUNT(*) AS n FROM usage").get() as { n: number }).n;
const requetes = (liste: ReadonlyArray<{ method: string; pathname: string }>, depuis: number): string[] => liste.slice(depuis).map((r) => `${r.method} ${r.pathname}`);
const consignesDe = (h: CockpitHarness, rootId: string): number => (h.db.prepare("SELECT COUNT(*) AS n FROM revoir_consignes WHERE root_id = ?").get(rootId) as { n: number }).n;

/** Racine posée en base (ligne `sessions`, récente, dans /workspace/proj) ; une racine de la salle a aussi sa ligne `omo_rooms`. */
function poserRacine(h: CockpitHarness, rootId: string, instance: SessionInstance): void {
  const maintenant = Date.now();
  h.db
    .prepare(
      "INSERT INTO sessions (id, parent_id, root_id, directory, title, purpose, instance, created_at, updated_at) VALUES (?, NULL, ?, '/workspace/proj', ?, 'chat', ?, ?, ?)",
    )
    .run(rootId, rootId, "[synthétique] conversation", instance, maintenant, maintenant);
  if (instance === "omo") h.db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, 'proj', ?)").run(rootId, maintenant);
}

/**
 * Ligne `autonomy_requests` (règle écrite de D-3d-09). La salle n'en écrit JAMAIS (omo-activation.ts, L22c) : ces lignes ne servent
 * qu'aux cas « fermé en cas de doute » ; une demande de la salle se pose avec `poserDemandeSalle` (répétition générale « 3s »).
 */
function poserDemande(h: CockpitHarness, id: string, rootId: string, finie: boolean): void {
  h.db
    .prepare("INSERT INTO autonomy_requests (id, root_id, choix, plafonds, started_at, ended_at) VALUES (?, ?, 'autonome', '{}', 100, ?)")
    .run(id, rootId, finie ? 200 : null);
}

/**
 * Demande de la salle telle que la SALLE l'écrit (omo-activation.ts, L22c), par le magasin réel : ligne « omo » de
 * conversation_autonomy, `demande` = {id, debut} dès l'envoi confirmé, null à la fin (endRequest) ou au démarrage qui la dit
 * « interrompue ». Correction de la répétition générale « 3s » : les tests de L3s-a fabriquaient une ligne `autonomy_requests`
 * « autonome » que la salle n'écrit jamais, d'où un vert que le banc démentait (« salle-fin-inconnue » après la fin de la demande).
 */
function poserDemandeSalle(h: CockpitHarness, rootId: string, enCours: boolean, retourCause: "interrompue" | null = null): void {
  new ConversationAutonomyStore(h.db).writeOmo(rootId, { plafondUsd: "0,50", demande: enCours ? { id: "req_l3sa_salle", debut: 100 } : null, depuis: 100, retourCause });
}

/** Accès à « Revoir » (état seul) d'une racine, dans le mode en vigueur. */
async function etatRevoir(h: CockpitHarness, rootId: string): Promise<RevoirEtatResponse> {
  const lu = await h.call("GET", `/api/revoir/${rootId}?etat=1`, { headers: h.headers.authed });
  assert.equal(lu.status, 200, lu.body);
  return lu.json<RevoirEtatResponse>();
}

/** Partie `task` à l'état `running`, émise sur l'instance voulue (h.emitOmo : processeur réel de la salle). */
const tache = (parent: string, callId: string, enfant: string, prompt: string) => ({
  type: "message.part.updated",
  properties: {
    sessionID: parent,
    part: {
      id: `prt_${callId}`,
      type: "tool",
      tool: "task",
      sessionID: parent,
      messageID: `msg_${callId}`,
      callID: callId,
      state: { status: "running", input: { prompt, subagent_type: "sisyphus-junior" }, metadata: { sessionId: enfant } },
    },
  },
});

// --- 1. Porte P-SALLE par le comportement ------------------------------------------------------------------------------------------

describe("croisements 3d-salle : porte P-SALLE (comportement de la salle dans chantier/1.1)", () => {
  it("Simple + racine de la salle → GET /api/conversations/:rootId/facts 403 (L18c inchangé) ; témoin Avancé → 200 ; SALLE_OUVERTE === false", async (t) => {
    assert.equal(SALLE_OUVERTE, false, "la salle est livrée fermée (décision (4) du 17/09)");
    const h = await startCockpit(t, { modules: "tous", omo: true });
    poserRacine(h, OMO_RACINE, "omo");
    const refus = await h.call("GET", `/api/conversations/${OMO_RACINE}/facts?since=0`, { headers: h.headers.authed });
    assert.equal(refus.status, 403, refus.body);
    h.settings.update({ ui: { mode: "avance" } });
    const avance = await h.call("GET", `/api/conversations/${OMO_RACINE}/facts?since=0`, { headers: h.headers.authed });
    assert.equal(avance.status, 200, "témoin : la route sert la salle en Avancé, le 403 vient bien du mode");
  });
});

// --- 2. Q6 : « Revoir » de la salle en Simple, sur le cockpit réel ----------------------------------------------------------------

describe("croisements 3d-salle : Q6 sur le cockpit réel (Revoir, consignes de la salle, P11)", () => {
  it("Simple : demande terminée → « Revoir » 200 et consigne capturée par la SALLE → 200 ; en cours → 403 (consigne comprise), entrée absente du zoom 1 ; zéro requête, zéro ligne usage", async (t) => {
    const h = await startCockpit(t, { modules: "tous", omo: true });
    assert.ok(h.omo);
    poserRacine(h, OMO_RACINE, "omo");
    // Demande finie, telle que la salle l'écrit (ligne « omo ») : AUCUNE ligne `autonomy_requests` (répétition générale « 3s »).
    poserDemandeSalle(h, OMO_RACINE, false);
    h.cockpit.c11.ports.facts.append(omoFaits());
    // Consigne confiée dans la salle, vue par le processeur de la SALLE : gardée sous la racine de la salle.
    const prompt = "[synthétique] consigne confiée par l'orchestrateur de la salle à un assistant";
    await h.emitOmo({ directory: "/workspace/proj", payload: { id: "evt_l3sa_q6", ...tache(OMO_RACINE, "call_l3sa_q6", "ses_jp_junior", prompt) } });
    assert.equal(consignesDe(h, OMO_RACINE), 1, "consigne gardée par la capture de la salle");
    // gf5:d11 : la table des attentes de la salle relit GET /permission à la première apparition de /workspace/proj sur son flux ;
    // cette lecture appartient à l'événement ci-dessus, pas à « Revoir ».
    await h.attentesAuRepos();

    const avantPrincipale = h.fake.requests.length;
    const avantSalle = h.omo.fake.requests.length;
    const usageAvant = lignesUsage(h);

    const revoir = await h.call("GET", `/api/revoir/${OMO_RACINE}`, { headers: h.headers.authed });
    assert.equal(revoir.status, 200, revoir.body);
    const lu = revoir.json<RevoirResponse>();
    assert.equal(lu.instance, "omo");
    assert.equal(lu.termine, true);
    const consigne = await h.call("GET", `/api/revoir/${OMO_RACINE}/consignes/call_l3sa_q6`, { headers: h.headers.authed });
    assert.equal(consigne.status, 200, consigne.body);
    assert.equal(consigne.json<RevoirConsigneResponse>().texte, prompt);
    assert.equal(consigne.json<RevoirConsigneResponse>().enfant, "ses_jp_junior");
    const zoom1 = (await h.call("GET", "/api/salle-controle/territoires", { headers: h.headers.authed })).json<TerritoiresResponse>();
    assert.deepEqual(
      (zoom1.salle?.projets ?? []).flatMap((p) => p.conversations.map((c) => [c.rootId, c.revoir])),
      [[OMO_RACINE, true]],
    );

    // Demande en cours (envoi confirmé, ligne « omo » écrite avant que la demande soit active) : « Revoir » et la consigne se
    // ferment ensemble, et le zoom 1 ne propose plus l'entrée.
    poserDemandeSalle(h, OMO_RACINE, true);
    for (const route of [`/api/revoir/${OMO_RACINE}`, `/api/revoir/${OMO_RACINE}/consignes/call_l3sa_q6`]) {
      const refus = await h.call("GET", route, { headers: h.headers.authed });
      assert.equal(refus.status, 403, `${route} : ${refus.body}`);
      assert.equal((refus.json() as { code?: string }).code, "salle-demande-en-cours");
    }
    const enCours = (await h.call("GET", "/api/salle-controle/territoires", { headers: h.headers.authed })).json<TerritoiresResponse>();
    assert.deepEqual((enCours.salle?.projets ?? []).flatMap((p) => p.conversations), [], "demande en cours : aucune entrée proposée");

    assert.deepEqual(requetes(h.fake.requests, avantPrincipale), [], "P11 : zéro requête au faux principal");
    assert.deepEqual(requetes(h.omo.fake.requests, avantSalle), [], "Simple : zéro requête au faux de la salle (Revoir et territoires)");
    assert.equal(lignesUsage(h), usageAvant, "aucune ligne usage pendant « Revoir »");
  });

  it("envoi et réponse d'autorisation vers la salle → 403 dans les DEUX modes, rien relayé au second faux ; envoi croisé par le montage principal → 404", async (t) => {
    const h = await startCockpit(t, { modules: "tous", omo: true });
    assert.ok(h.omo);
    poserRacine(h, OMO_RACINE, "omo");
    const avantSalle = h.omo.fake.requests.length;
    const avantPrincipale = h.fake.requests.length;
    for (const mode of ["simple", "avance"] as const) {
      h.settings.update({ ui: { mode } });
      const envoi = await h.call("POST", `/api/omo/oc/session/${OMO_RACINE}/prompt_async?directory=${encodeURIComponent("/workspace/proj")}`, {
        headers: h.headers.mutating,
        body: { parts: [{ type: "text", text: "[synthétique] continue" }] },
      });
      assert.equal(envoi.status, 403, `${mode} : ${envoi.body}`);
      const accord = await h.call("POST", "/api/omo/oc/permission/per_l3sa/reply", { headers: h.headers.mutating, body: { reply: "once" } });
      assert.equal(accord.status, 403, `${mode} : ${accord.body}`);
      const croise = await h.call("POST", `/api/oc/session/${OMO_RACINE}/prompt_async?directory=${encodeURIComponent("/workspace/proj")}`, {
        headers: h.headers.mutating,
        body: { parts: [{ type: "text", text: "[synthétique] continue" }] },
      });
      assert.equal(croise.status, 404, `${mode} : envoi croisé ${croise.body}`);
    }
    assert.deepEqual(requetes(h.omo.fake.requests, avantSalle), [], "rien relayé au faux de la salle");
    assert.deepEqual(requetes(h.fake.requests, avantPrincipale), [], "rien relayé au faux principal");
  });

  it("TÉMOIN Q6 (Avancé, salle ouverte PAR LE HARNAIS → envoi relayé ≠ 403) : aucun moyen ne l'ouvre sans toucher SALLE_OUVERTE ni http.ts → en attente, jamais remplacé par le seul 403", () => {
    // Constat qui rend le témoin impossible ici : la porte du montage lit la CONSTANTE, pas `Cockpit11.salleOuverte`.
    const http = lire("server/http.ts");
    assert.match(http, /const refus = refusMontageSalle\(\{\n\s*salleOuverte: SALLE_OUVERTE,/, "si ce contrôle tombe, un témoin est peut-être possible : l'écrire");
    // Le harnais ne porte aucune option qui ouvrirait la salle (sa seule option de la salle est `omo`).
    const harnais = lire("server/test-support/cockpit-harness.ts");
    assert.equal(/salleOuverte|SALLE_OUVERTE\s*=/.test(harnais.replace(/^\s*(?:\/\/|\*).*$/gm, "")), false, "le harnais ne bascule pas la salle");
    // Ce qui est contrôlable sans ouvrir la salle : la décision pure de la porte, salle ouverte (discriminante entre les modes).
    const ouverte = { salleOuverte: true, omoActif: true, instancePresente: true };
    assert.equal(refusMontageSalle({ ...ouverte, mode: "avance" }), null, "salle ouverte, Avancé : relayé");
    assert.equal(refusMontageSalle({ ...ouverte, mode: "simple" }), "mode-avance", "salle ouverte, Simple : 403");
  });

  it(
    "TÉMOIN Q6 bout en bout : envoi relayé au second faux en Avancé, salle ouverte",
    {
      skip: "en attente : remis à l'orchestrateur — piste : banc run-e2e.sh --faux --salle (qui ne bascule SALLE_OUVERTE que dans sa copie d'archive) au train ou à la répétition générale de « 3s »",
    },
    () => undefined,
  );

  it("consignes : jamais croisées — la salle n'écrit jamais sous une racine principale, le processeur principal jamais sous une racine de la salle", async (t) => {
    const h = await startCockpit(t, { modules: "tous", omo: true });
    poserRacine(h, "ses_l3sa_principale", "principale");
    poserRacine(h, OMO_RACINE, "omo");
    await h.emitOmo({ directory: "/workspace/proj", payload: { id: "evt_l3sa_croise", ...tache("ses_l3sa_principale", "call_l3sa_croise", "ses_x", "[synthétique] croisée") } });
    assert.equal(consignesDe(h, "ses_l3sa_principale"), 0);
    await h.emitOmo({ directory: "/workspace/proj", payload: { id: "evt_l3sa_salle", ...tache(OMO_RACINE, "call_l3sa_salle", "ses_y", "[synthétique] de la salle") } });
    assert.equal(consignesDe(h, OMO_RACINE), 1, "témoin : la même partie sur une racine de la salle est gardée");
  });

  it("territoires, Avancé : l'état de la salle est lu sur SON instance (second faux), jamais sur le principal ; statutVerifie vrai", async (t) => {
    const h = await startCockpit(t, { modules: "tous", omo: true, settings: { ui: { mode: "avance" } } });
    assert.ok(h.omo);
    poserRacine(h, OMO_RACINE, "omo");
    poserDemandeSalle(h, OMO_RACINE, true);
    const avantPrincipale = h.fake.requests.length;
    const avantSalle = h.omo.fake.requests.length;
    const vue = (await h.call("GET", "/api/salle-controle/territoires", { headers: h.headers.authed })).json<TerritoiresResponse>();
    assert.deepEqual(requetes(h.omo.fake.requests, avantSalle), ["GET /session/status"]);
    assert.deepEqual(requetes(h.fake.requests, avantPrincipale), [], "P11");
    assert.equal(vue.salle?.projets[0]?.conversations[0]?.travaillent, 0);
    assert.equal(vue.statutVerifie, true);
  });
});

// --- 3 bis. Fin de la demande de la salle (répétition générale « 3s ») --------------------------------------------------------------
// La salle tient sa demande dans la ligne « omo » de conversation_autonomy et dans le port omoActivation (activeRequest), jamais dans
// `autonomy_requests` (omo-activation.ts). « Revoir », ses consignes gardées et le zoom 1 lisent ces sources, fermés en cas de doute.

describe("croisements 3d-salle : fin de la demande de la salle, lue là où la salle l'écrit (répétition générale « 3s »)", () => {
  it("Simple : sans AUCUNE ligne `autonomy_requests`, demande finie (ligne « omo », fin ou « interrompue ») → « Revoir » permis, consignes et zoom 1 compris ; en cours → « salle-demande-en-cours »", async (t) => {
    const h = await startCockpit(t, { modules: "tous", omo: true });
    assert.ok(h.omo);
    poserRacine(h, OMO_RACINE, "omo");
    h.cockpit.c11.ports.facts.append(omoFaits());
    await h.emitOmo({ directory: "/workspace/proj", payload: { id: "evt_l3sa_fin", ...tache(OMO_RACINE, "call_l3sa_fin", "ses_jp_junior", "[synthétique] consigne de la salle") } });
    const nAutonomie = () => (h.db.prepare("SELECT COUNT(*) AS n FROM autonomy_requests").get() as { n: number }).n;
    const conversationsDuZoom1 = async () =>
      ((await h.call("GET", "/api/salle-controle/territoires", { headers: h.headers.authed })).json<TerritoiresResponse>().salle?.projets ?? []).flatMap((p) =>
        p.conversations.map((c) => [c.rootId, c.revoir]),
      );

    // Envoi confirmé : la salle écrit sa ligne « omo » avec la demande.
    poserDemandeSalle(h, OMO_RACINE, true);
    assert.deepEqual(await etatRevoir(h, OMO_RACINE), { rootId: OMO_RACINE, acces: false, raison: "salle-demande-en-cours", instance: "omo" });
    assert.deepEqual(await conversationsDuZoom1(), []);

    // Fin de la demande (endRequest) : même ligne, demande effacée.
    poserDemandeSalle(h, OMO_RACINE, false);
    assert.deepEqual(await etatRevoir(h, OMO_RACINE), { rootId: OMO_RACINE, acces: true, raison: null, instance: "omo" });
    const revoir = await h.call("GET", `/api/revoir/${OMO_RACINE}`, { headers: h.headers.authed });
    assert.equal(revoir.status, 200, revoir.body);
    assert.equal(revoir.json<RevoirResponse>().termine, true);
    const consigne = await h.call("GET", `/api/revoir/${OMO_RACINE}/consignes/call_l3sa_fin`, { headers: h.headers.authed });
    assert.equal(consigne.status, 200, consigne.body);
    assert.deepEqual(await conversationsDuZoom1(), [[OMO_RACINE, true]]);

    // Demande dite « interrompue » par le démarrage suivant (interruptSalleAtStartup) : finie aussi.
    poserDemandeSalle(h, OMO_RACINE, true);
    poserDemandeSalle(h, OMO_RACINE, false, "interrompue");
    assert.equal((await etatRevoir(h, OMO_RACINE)).acces, true);
    assert.equal(nAutonomie(), 0, "la salle n'écrit jamais `autonomy_requests`");
  });

  it("fermé en cas de doute : aucune demande connue, ligne « omo » illisible, port qui lève → « salle-fin-inconnue » ; port actif sur la racine ou dernière ligne `autonomy_requests` ouverte → en cours ; instance principale inchangée", async (t) => {
    const h = await startCockpit(t, { modules: "tous", omo: true });
    poserRacine(h, OMO_RACINE, "omo");
    poserRacine(h, "ses_l3sa_principale", "principale");
    const raison = async (rootId = OMO_RACINE) => (await etatRevoir(h, rootId)).raison;

    // Aucune demande connue (ni ligne « omo », ni demande active, ni `autonomy_requests`) : fin inconnue, comme avant.
    assert.equal(await raison(), "salle-fin-inconnue");
    // Ligne « omo » au contenu illisible (le magasin la lit « sans demande ») : jamais lue comme finie.
    for (const plafonds of ["{", "[]", "{}", '{"plafondUsd":"0,50"}', '{"plafondUsd":"0,50","demande":"oui"}', '{"plafondUsd":"0,50","demande":null,"autre":1}']) {
      h.db
        .prepare("INSERT INTO conversation_autonomy (root_id, choix, plafonds, depuis, retour_cause) VALUES (?, 'omo', ?, 100, NULL) ON CONFLICT(root_id) DO UPDATE SET plafonds = excluded.plafonds")
        .run(OMO_RACINE, plafonds);
      assert.equal(await raison(), "salle-fin-inconnue", plafonds);
    }
    // Demande finie selon la ligne, mais encore active en mémoire sur CETTE racine (port omoActivation) : en cours.
    poserDemandeSalle(h, OMO_RACINE, false);
    assert.equal(await raison(), null, "témoin : ligne finie seule → permis");
    const ports = h.cockpit.c11.ports;
    const neutre = ports.omoActivation;
    t.after(() => {
      ports.omoActivation = neutre;
    });
    ports.omoActivation = { ...neutre, activeRequest: () => ({ rootId: OMO_RACINE, requestId: "req_l3sa_actif", startedAt: 100, plafondUsd: "0,50" }) };
    assert.equal(await raison(), "salle-demande-en-cours");
    // Active sur une AUTRE racine de la salle (une seule demande à la fois, D-2b-08) : celle-ci reste finie.
    ports.omoActivation = { ...neutre, activeRequest: () => ({ rootId: "ses_l3sa_autre", requestId: "req_l3sa_autre", startedAt: 100, plafondUsd: "0,50" }) };
    assert.equal(await raison(), null);
    // Port illisible : fin inconnue.
    ports.omoActivation = {
      ...neutre,
      activeRequest: () => {
        throw new Error("[synthétique] port illisible");
      },
    };
    assert.equal(await raison(), "salle-fin-inconnue");
    ports.omoActivation = neutre;
    // Dernière ligne `autonomy_requests` ouverte (règle écrite de D-3d-09) : en cours, même si la ligne « omo » est finie.
    poserDemande(h, "aur_l3sa_doute", OMO_RACINE, false);
    assert.equal(await raison(), "salle-demande-en-cours");
    // Instance principale : toujours consultable, quelles que soient ces sources.
    assert.equal(await raison("ses_l3sa_principale"), null);
  });
});

// --- 4. Enceinte --------------------------------------------------------------------------------------------------------------------

describe("croisements 3d-salle : enceinte (JP-10)", () => {
  it("texte `avance` de l'enceinte = début du bandeau permanent de la salle, jusqu'à « avant exécution »", () => {
    const bandeau = OMO_TEXTES.avance.bandeau.texte;
    const fin = bandeau.indexOf("avant exécution") + "avant exécution".length;
    assert.ok(fin > "avant exécution".length, "le bandeau dit « avant exécution »");
    assert.equal(SALLE3D.avance.enceinte, bandeau.slice(0, fin));
    // Le zoom 2 écrit ce bandeau pour une conversation de la salle en Avancé (L3s-a), le zoom 1 aussi.
    assert.match(lire("web/pages/salle-controle/ZoomConversation.tsx"), /\{vue\.enceinte === null \? null : <p className="zoom-conv-note">\{SALLE\.avance\.enceinte\}<\/p>\}/);
  });
});

// --- 5. Fixtures de la salle ----------------------------------------------------------------------------------------------------------

const SALLE_AVANCE: NeonSceneOptions = { zoom: 2, mode: "avance", roleSalle: roleDeAgent };
const planDe = (faits: readonly ActivityFact[], t: number | null, vue: NeonSceneOptions): Plan3d => planConversation(scene(faits, t, vue), { theme: "sombre", mode: vue.mode });

describe("croisements 3d-salle : plan 3D sur les fixtures de la salle", () => {
  for (const capture of CAPTURES_SALLE) {
    it(`${capture} : « différé = direct » du plan 3D à chaque moment (Avancé, Simple, zoom 3) ; chaque signe porte des faits visibles (P12)`, () => {
      const faits = capture === OMO_FIXTURE ? omoFaits() : rejouer(capture);
      assert.ok(faits.length >= 10, `${capture} : ${faits.length} faits`);
      const depuisBase = relus(faits);
      const sessions = [...new Set(faits.map((f) => f.sessionId))];
      const vues: NeonSceneOptions[] = [SALLE_AVANCE, { ...SALLE_AVANCE, mode: "simple" }, ...sessions.map((focus) => ({ ...SALLE_AVANCE, zoom: 3 as const, focus }))];
      for (const t of [...moments(faits), null]) {
        const n = visibleCount(faits, t);
        for (const vue of vues) {
          const direct = planDe(faits.slice(0, n), null, vue);
          assert.deepEqual(planDe(faits, t, vue), direct, `${capture} t=${t}`);
          assert.deepEqual(planDe(depuisBase, t, vue), direct, `${capture} relu t=${t}`);
          const signes = [
            ...direct.noeuds,
            ...direct.faisceaux,
            ...direct.marques,
            ...direct.tuiles,
            ...(direct.liensCarnet ?? []),
          ];
          for (const signe of signes) {
            assert.ok(signe.faits.length > 0, `${capture} : signe sans fait`);
            for (const i of signe.faits) assert.ok(i >= 0 && i < n, `${capture} : fait ${i} sur ${n}`);
          }
        }
      }
    });
  }

  it("omo-jp1-jp7 : carnet porté par la scène → tuiles et liens dans le plan, dessinés par le graphe three.js, puis tout libéré une fois", () => {
    const vue = scene(omoFaits(), null, SALLE_AVANCE);
    assert.ok(vue.carnet.tuiles.length >= 2 && vue.carnet.liens.length >= 1, "la fixture porte le carnet (JP-6)");
    const plan = planConversation(vue, { theme: "sombre", mode: "avance" });
    const lots = plan.tuiles.filter((lot) => lot.dossier === PLAN3D_SALLE.dossierCarnet);
    assert.equal(lots.reduce((n, lot) => n + lot.positions.length, 0), vue.carnet.tuiles.filter((t2) => t2.position !== null).length);
    assert.equal(plan.liensCarnet?.length, vue.carnet.liens.length);

    const comptes = new Map<object, number>();
    const restaurer: Array<() => void> = [];
    for (const prototype of [BufferGeometry.prototype, Texture.prototype, InstancedMesh.prototype, MeshBasicMaterial.prototype, LineBasicMaterial.prototype, SpriteMaterial.prototype, ShaderMaterial.prototype] as Array<{ dispose(): void }>) {
      const original = prototype.dispose;
      prototype.dispose = function espion(this: object) {
        comptes.set(this, (comptes.get(this) ?? 0) + 1);
        original.call(this);
      };
      restaurer.push(() => {
        prototype.dispose = original;
      });
    }
    try {
      const graphe = creerGraphe(plan, NEON_PALETTES.sombre);
      const noms: string[] = [];
      graphe.racine.traverse((objet) => void noms.push(objet.name));
      for (const lien of plan.liensCarnet ?? []) assert.ok(noms.includes(`lien-carnet:${lien.id}`), `lien ${lien.id} dessiné`);
      for (const lot of lots) assert.ok(noms.includes(`tuiles:${lot.dossier}:${lot.etat}`), `tuiles ${lot.etat} dessinées`);
      graphe.liberer();
      assert.equal(graphe.nombreObjets(), 0);
      assert.ok(comptes.size > 0);
      assert.deepEqual(
        [...comptes.values()].filter((n) => n !== 1),
        [],
        "chaque ressource libérée exactement une fois",
      );
    } finally {
      for (const r of restaurer) r();
    }
  });

  it("vue Simple de « Revoir » d'une racine de la salle (omo-jp1-jp7) : au moins 2 assistants, noms par roleDeAgent, aucun nom d'agent, ni « agent » ni « orchestrateur »", () => {
    const faits = omoFaits();
    const permis = new Set<string>([REVOIR.simple.assistantPrincipal, ...NEON_SECTEURS.map((s) => libelleSecteur(s))]);
    const nomsDeLaFixture = [...new Set(scene(faits, null, SALLE_AVANCE).noeuds.map((n) => n.agent ?? "").filter((nom) => nom !== ""))];
    assert.ok(nomsDeLaFixture.length >= 2, nomsDeLaFixture.join(", "));
    const mode = modeSceneRevoir({ salle: true, advanced: false });
    let vus = 0;
    for (const t of [...moments(faits), null]) {
      const brute = scene(faits, t, { zoom: 2, mode, roleSalle: roleDeAgent });
      if (brute.noeuds.length < 2) continue;
      vus += 1;
      const vue = vueSimple(brute, nomsSimples(brute, true));
      for (const noeud of vue.noeuds) {
        const agent = brute.noeuds.find((b) => b.sessionId === noeud.sessionId)?.agent ?? null;
        const attendu = noeud.role === "conversation" ? REVOIR.simple.assistantPrincipal : libelleSecteur(roleDeAgent(agent));
        assert.equal(noeud.agent, attendu, noeud.sessionId);
        assert.ok(permis.has(noeud.agent ?? ""), noeud.agent ?? "");
      }
      const montre = [...lignesTableau(vue).flatMap((l) => [l.nom, l.secteur ?? "", l.etat, ...l.signes]), ...vue.noeuds.map((n) => libelleNoeud(n))].join(" | ");
      for (const nom of nomsDeLaFixture) assert.equal(montre.includes(nom), false, `nom d'agent montré : ${nom}`);
      assert.equal(/agent|orchestrateur/i.test(montre), false, montre);
    }
    assert.ok(vus > 0, "aucun moment ne dessine deux assistants");
    // Discriminant : l'assistant « sisyphus-junior » de la fixture est dit par son rôle, « Exécuter ».
    const derniere = vueSimple(scene(faits, null, { zoom: 2, mode, roleSalle: roleDeAgent }), nomsSimples(scene(faits, null, { zoom: 2, mode, roleSalle: roleDeAgent }), true));
    assert.equal(derniere.noeuds.find((n) => n.sessionId === "ses_jp_junior")?.agent, libelleSecteur("executer"));
    // « Revoir » calcule sa scène avec les rôles de la salle (comme la bande) avant vueSimple : positions et noms disent le même rôle.
    assert.match(
      lire("web/pages/salle-controle/revoir/RevoirDialog.tsx"),
      /scene\(faits\.slice\(0, visibleCount\(faits, t\)\), null, \{ zoom, mode: modeSceneRevoir\(\{ salle, advanced \}\), focus, roleSalle: roleDeAgent \}\)/,
    );
  });

  it("légendes de la salle (omo-jp1-jp7) : tâche de fond BRANCHÉE sans prédicat de l'appelant ; « neuf » jamais sur une reprise ; au plus 2 clés", () => {
    const faits = omoFaits();
    const toutes = [...moments(faits)].flatMap((t) => legendesAuMoment(faits, t, { salle: true }));
    const fond = toutes.filter((l) => l.cles.includes("tache-de-fond"));
    assert.deepEqual(
      fond.map((l) => [l.callId, l.ancre.genre]),
      [["call_jp_fond", "faisceau"]],
    );
    const reprises = faits.filter((f) => f.kind === "consigne" && f.data.etat === "envoyee" && f.data.reprise === true).map((f) => String(f.data.callId));
    assert.ok(reprises.length >= 1, "la fixture porte une reprise (task_id)");
    for (const legende of toutes) {
      assert.ok(legende.cles.length <= 2);
      if (legende.callId !== null && reprises.includes(legende.callId)) assert.equal(legende.cles.includes("neuf"), false, legende.callId);
    }
    // Témoin : hors de la salle, les mêmes faits ne portent pas la tâche de fond.
    assert.equal(
      [...moments(faits)].flatMap((t) => legendesAuMoment(faits, t, { salle: false })).some((l) => l.cles.includes("tache-de-fond")),
      false,
    );
  });
});

// --- 6. legendes-salle.ts sans texte (lexique recopié de textes.test.ts, par textes-3d.test.ts) --------------------------------------

/** Mots-clés après lesquels « / » ouvre une expression régulière. */
const BEFORE_EXPRESSION = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const IDENT_CHAR = /[\p{L}\p{N}_$]/u;

function unescapeJs(raw: string): string {
  const simples: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: String.fromCharCode(8), f: String.fromCharCode(12), v: String.fromCharCode(11), 0: String.fromCharCode(0) };
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g, (_, seq: string) => {
    if (seq.length > 1 && (seq[0] === "u" || seq[0] === "x")) return String.fromCodePoint(Number.parseInt(seq.slice(1).replace(/[{}]/g, ""), 16));
    if (seq === "\r\n" || seq === "\n" || seq === "\r" || seq === String.fromCharCode(0x2028) || seq === String.fromCharCode(0x2029)) return "";
    return simples[seq] ?? seq;
  });
}

function readRegex(source: string, start: number): number {
  let at = start + 1;
  let inClass = false;
  while (at < source.length && source[at] !== "\n") {
    const c = source.charAt(at);
    if (c === "\\") {
      at += 2;
      continue;
    }
    if (c === "/" && !inClass) {
      at += 1;
      while (at < source.length && IDENT_CHAR.test(source.charAt(at))) at += 1;
      return at;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    at += 1;
  }
  return -1;
}

/** Chaînes littérales et morceaux fixes de gabarits d'un source TypeScript (commentaires et expressions régulières écartés). */
function sourceLiterals(source: string): Array<{ ligne: number; texte: string }> {
  const out: Array<{ ligne: number; texte: string }> = [];
  const ligne = (at: number) => source.slice(0, at).split("\n").length;
  const step = (at: number) => (source[at] === "\\" ? (source.startsWith("\r\n", at + 1) ? at + 3 : at + 2) : at + 1);
  type Frame = { depth: number; pieces: Array<{ at: number; raw: string }> };
  const suspended: Frame[] = [];
  let depth = 0;
  let regexAllowed = true;
  const emit = (frame: Frame) => {
    for (const piece of frame.pieces) out.push({ ligne: ligne(piece.at), texte: unescapeJs(piece.raw) });
  };
  const readTemplate = (frame: Frame, from: number): number => {
    let at = from;
    while (at < source.length && source[at] !== "`" && !(source[at] === "$" && source[at + 1] === "{")) at = step(at);
    frame.pieces.push({ at: from, raw: source.slice(from, Math.min(at, source.length)) });
    if (source[at] === "$") {
      depth += 1;
      frame.depth = depth;
      suspended.push(frame);
      regexAllowed = true;
      return at + 2;
    }
    emit(frame);
    regexAllowed = false;
    return at + 1;
  };
  let i = 0;
  while (i < source.length) {
    const c = source.charAt(i);
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (c === '"' || c === "'") {
      let at = i + 1;
      while (at < source.length && source[at] !== c && source[at] !== "\n") at = step(at);
      out.push({ ligne: ligne(i), texte: unescapeJs(source.slice(i + 1, Math.min(at, source.length))) });
      i = at + 1;
      regexAllowed = false;
    } else if (c === "`") {
      i = readTemplate({ depth: 0, pieces: [] }, i + 1);
    } else if (c === "}" && suspended.at(-1)?.depth === depth) {
      depth -= 1;
      i = readTemplate(suspended.pop() as Frame, i + 1);
    } else if (IDENT_CHAR.test(c)) {
      let at = i + 1;
      while (at < source.length && IDENT_CHAR.test(source.charAt(at))) at += 1;
      regexAllowed = BEFORE_EXPRESSION.has(source.slice(i, at));
      i = at;
    } else if (c === "/" && regexAllowed && readRegex(source, i) !== -1) {
      i = readRegex(source, i);
      regexAllowed = false;
    } else {
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      if (!/\s/u.test(c)) regexAllowed = !(c === ")" || c === "]" || c === "}");
      i += 1;
    }
  }
  for (const frame of suspended) emit(frame);
  return out;
}

/** Code (identifiant, clé, valeur d'énumération) plutôt que texte : minuscules ASCII et chiffres, séparés par - _ . ou :. */
const CODE_LIKE = /^[a-z0-9]+(?:[-_.:][a-z0-9]+)*$/;
/** Texte affichable : lettre et espace, lettre accentuée, ou mot à majuscule initiale. */
const looksDisplayed = (texte: string) =>
  (/\p{L}/u.test(texte) && /\s/u.test(texte)) || /(?=\P{ASCII})\p{L}/u.test(texte) || /^\p{Lu}\p{Ll}[\p{L}'’-]*[.!?…]?$/u.test(texte);
const texteAffichable = (source: string) =>
  sourceLiterals(source)
    .filter(({ texte }) => !CODE_LIKE.test(texte) && looksDisplayed(texte))
    .map(({ ligne, texte }) => `ligne ${ligne} : ${texte}`);

describe("croisements 3d-salle : legendes-salle.ts sans texte (D-3d-21)", () => {
  it("aucune chaîne affichable, seulement des codes ASCII en minuscules ; le contrôle refuse une phrase fabriquée", () => {
    assert.deepEqual(texteAffichable(lire("server/shared/legendes-salle.ts")), []);
    // Discriminant : le même contrôle attrape une phrase, un gabarit, un mot à majuscule initiale ou un mot accentué.
    const fabrique = ['export const a = "Il peut lire le carnet";', "export const b = (n: number) => `Carnet ${n}`;", 'export const c = "Carnet";', 'export const d = "réservé";', 'export const e = "tache-de-fond";'].join("\n");
    assert.deepEqual(texteAffichable(fabrique), ["ligne 1 : Il peut lire le carnet", "ligne 2 : Carnet ", "ligne 3 : Carnet", "ligne 4 : réservé"]);
    // Pureté du module : ni node, ni process, ni horloge ; un seul import, de types, et jamais un module de textes.
    const source = lire("server/shared/legendes-salle.ts");
    assert.equal(/"node:|\bprocess\.|Date\.now|new Date\b|Math\.random/.test(source), false);
    assert.deepEqual(
      [...source.matchAll(/^import[^\n]*from\s*["']([^"']+)["'];?$/gm)].map((m) => m[0]),
      ['import type { ActivityFact } from "./activity-types.ts";'],
    );
  });
});
