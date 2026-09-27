// Tests de croisement de la grande fusion, GF12 après GF2 (plan d'exécution it5 §8.6 « GF12, après la fusion de la 3D » ; plan
// it3 §8.4 (a), repris en entier). La 3D (H3) rejoint `chantier/1.1`, qui porte déjà l'itération 2 et la salle (GF1). Chaque
// branche a ses propres tests : ici, seulement ce qui ne se voit QU'UNE FOIS les trois réunies.
// 1. it2 × 3D : la fixture d'autonomie (autonomie-p8.jsonl) jouée sur le câblage complet ; « Revoir » d'une conversation
//    autonome de l'instance principale → 200 en Simple, zéro requête à opencode, zéro ligne `usage` ; « différé = direct » du
//    plan 3D ; un bouclier (ou une croix) dessiné en 3D pour chaque fait `decision` signé.
// 2. salle × 3D : enceinte 2D (L25b) et 3D (zoom 1) avec le même texte ; commandes de la bande d'une racine de la salle
//    ([Revoir cette demande] en Avancé seulement) ; Q6 en Simple (`/facts` → 403, « Revoir » d'une demande terminée → 200, en
//    cours → 403, envoi et réponse d'autorisation refusés) ; zoom 1 Simple sans compteur de la salle ; P11 sur les territoires ;
//    vue Simple de « Revoir » sans nom d'agent sur omo-jp1-jp7.jsonl.
// 3. « Revoir » et consignes (U2) : copie locale bornée avec sa mention de troncature, zéro requête et zéro ligne `usage` ; les
//    autres textes restent « Texte non affiché pendant « Revoir » » ; une consigne de la salle suit la règle Q6 ; capture sur le
//    processeur PRINCIPAL inchangée par le filtre d'instance de T3b ; purge → faits et consignes supprimés ensemble.
// 4. Migrations (A2, A2 bis ; plan it5 §8.5) : 1 à 5, vraie 6 de la salle, 7 réservée vide, 8 de la 3D ; montée depuis 5, 6 et 7.
// 5. Contrôles de la fusion : NeonCarte et NeonTableau exportés ; SALLE_OUVERTE fausse ; wiring-11 inchangé par la 3D ; three
//    seul ajout (P8) et garde du build ; périmètres des contrôles de mouvement et de textes présents des deux côtés.
// Aucun appel facturé : faux opencode seulement. Aucune fixture fabriquée : captures du dépôt, lignes posées en base jetable.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import { textesPanneau } from "../web/pages/salle-controle/useFaitsConversation.ts";
import { createConsignesStore } from "./consignes-store.ts";
import type { PermissionGate } from "./contracts-11.ts";
import { purgeConversation } from "./conversation-purge.ts";
import { MIGRATIONS, openDb, openMemoryDb, transaction } from "./db.ts";
import type { AppDeps } from "./http.ts";
import { refusMontageSalle } from "./oc-proxy.ts";
import { createPermissionGate } from "./permission-gate.ts";
import { SessionTracker } from "./sessions.ts";
import { EventMemory, type FactContext, FactDeduper, type FactEvent, factsFromEvent, type FactSession } from "./shared/activity-facts.ts";
import type { ActivityFact, FactsResponse, SessionInstance } from "./shared/activity-types.ts";
import { CONSIGNES, pointsDeCode } from "./shared/consignes.ts";
import { libelleNoeud, lignesTableau } from "./shared/neon-band.ts";
import { NEON_GRAMMAIRE } from "./shared/neon-palette.ts";
import { planConversation } from "./shared/neon-plan3d.ts";
import { moments, NEON_SECTEURS, type NeonSceneOptions, scene, visibleCount } from "./shared/neon-scene.ts";
import { libelleSecteur, TEXTES as NEON } from "./shared/neon-texts.ts";
import { occupeesSelonFaits } from "./shared/revoir-access.ts";
import { libelleConsigneTronquee, TEXTES as REVOIR } from "./shared/revoir-texts.ts";
import { TEXTES as SALLE3D } from "./shared/salle3d-texts.ts";
import type { Plan3d, RevoirConsigneResponse, RevoirEtatResponse, RevoirResponse, TerritoiresResponse } from "./shared/salle3d-types.ts";
import { planTerritoires } from "./shared/territoires.ts";
import { modeSceneRevoir, nomsSimples, vueSimple } from "./shared/vue-simple.ts";
import { type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import { readCapture } from "./test-support/fake-opencode.ts";
import { until } from "./test-support/helpers.ts";
import { SALLE_OUVERTE } from "./wiring-11.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const DEPOT = path.join(APP_DIR, "..");
const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const DQ = String.fromCharCode(34);
const lire = (relatif: string): string => fs.readFileSync(path.join(APP_DIR, relatif), "utf8");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const AVANCE: NeonSceneOptions = { zoom: 2, mode: "avance" };
const SIMPLE: NeonSceneOptions = { zoom: 2, mode: "simple" };
const planDe = (faits: readonly ActivityFact[], t: number | null, vue: NeonSceneOptions): Plan3d =>
  planConversation(scene(faits, t, vue), { theme: "sombre", mode: vue.mode });

// --- Rejeu d'une capture, comme le direct (factsFromEvent puis FactDeduper), instance au choix ------------------------------------

/**
 * Faits d'une capture rejouée hors du cockpit, par le même chemin que le direct : les sessions sans parent sont des racines de
 * `instance` ; `envoyes` sont les messages que le cockpit a envoyés (lignes `prompts`).
 */
function rejouer(capture: string, instance: SessionInstance, envoyes: readonly string[]): ActivityFact[] {
  const sessions = new Map<string, FactSession>();
  const resolve = (id: string, info?: Readonly<Record<string, unknown>>): FactSession | null => {
    const connue = sessions.get(id);
    if (connue) return connue;
    if (info?.id !== id) return null;
    const parentId = typeof info.parentID === "string" ? info.parentID : null;
    const parent = parentId === null ? undefined : sessions.get(parentId);
    if (parentId !== null && !parent) return null;
    return { rootId: parent ? parent.rootId : id, parentId, purpose: "chat", instance };
  };
  const memoire = new EventMemory();
  const dedoublonneur = new FactDeduper();
  const faits: ActivityFact[] = [];
  for (const { recv, wire } of readCapture(capture)) {
    const event = wire.payload as FactEvent;
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

/** Fixture synthétique de la salle (L25a) : une racine de la Salle OMO, dont seule la demande figure dans `prompts`. */
const OMO_FIXTURE = "omo-jp1-jp7.jsonl";
const OMO_RACINE = "ses_jp_racine";
const omoFaits = (): ActivityFact[] => rejouer(OMO_FIXTURE, "omo", ["msg_jp_demande"]);

// --- Lectures communes ----------------------------------------------------------------------------------------------------------

const lignesUsage = (h: CockpitHarness): number => (h.db.prepare("SELECT COUNT(*) AS n FROM usage").get() as { n: number }).n;
const requetes = (liste: ReadonlyArray<{ method: string; pathname: string }>, depuis: number): string[] =>
  liste.slice(depuis).map((r) => `${r.method} ${r.pathname}`);
const compter = (h: CockpitHarness, table: string, rootId: string): number =>
  (h.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE root_id = ?`).get(rootId) as { n: number }).n;

/** Racine de conversation posée en base (ligne `sessions`), récente, dans /workspace/proj. */
function poserRacine(h: CockpitHarness, rootId: string, instance: SessionInstance): void {
  const maintenant = Date.now();
  h.db
    .prepare(
      "INSERT INTO sessions (id, parent_id, root_id, directory, title, purpose, instance, created_at, updated_at) VALUES (?, NULL, ?, '/workspace/proj', ?, 'chat', ?, ?, ?)",
    )
    .run(rootId, rootId, "[synthétique] conversation", instance, maintenant, maintenant);
  // Une racine de la salle est aussi une ligne `omo_rooms` (migration 6) : c'est ce que lit isRoomRoot (L18c).
  if (instance === "omo") h.db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, 'proj', ?)").run(rootId, maintenant);
}

/** Dernière demande d'autonomie de la racine, terminée ou non (règle Q6, D-3d-09). */
function poserDemande(h: CockpitHarness, id: string, rootId: string, finie: boolean): void {
  h.db
    .prepare("INSERT INTO autonomy_requests (id, root_id, choix, plafonds, started_at, ended_at) VALUES (?, ?, 'autonome', '{}', 100, ?)")
    .run(id, rootId, finie ? 200 : null);
}

// --- 1. it2 × 3D : fixture d'autonomie sur le câblage complet --------------------------------------------------------------------

const CLEAN_GIT_CONFIG = [
  "[core]",
  `${TAB}repositoryformatversion = 0`,
  `${TAB}filemode = true`,
  `${TAB}bare = false`,
  `[remote ${DQ}origin${DQ}]`,
  `${TAB}url = https://example.invalid/depot.git`,
  "",
].join(NL);

/** Workspace réel monté en /workspace : `proj` = dossier de la fixture d'autonomie, avec un dépôt git sain (faits shell). */
function workspace(t: TestContext): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-croisements-3d-fusion-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const proj = path.join(root, "proj");
  for (const dir of ["src", ".git/objects", ".git/refs"]) fs.mkdirSync(path.join(proj, ...dir.split("/")), { recursive: true });
  const fichiers: Record<string, string> = {
    "README.md": `# Projet${NL}`,
    "src/app.ts": `// TODO${NL}`,
    "src/a.ts": `export {};${NL}`,
    "a.txt": `ligne 1${NL}ligne 2${NL}`,
    ".git/HEAD": `ref: refs/heads/main${NL}`,
    ".git/config": CLEAN_GIT_CONFIG,
  };
  for (const [nom, contenu] of Object.entries(fichiers)) fs.writeFileSync(path.join(proj, ...nom.split("/")), contenu);
  return root;
}

async function demarrer(t: TestContext, options: CockpitHarnessOptions = {}): Promise<CockpitHarness> {
  return startCockpit(t, { modules: "tous", ...options, env: { workspaceDir: workspace(t), ...(options.env ?? {}) } });
}

/** Portillon réel dont le relais répond « ok » : un rejeu n'a aucune demande vivante chez opencode (fixture de L10a). */
const RELAIS_OK = (deps: AppDeps): PermissionGate => {
  const reel = createPermissionGate({ client: deps.client, db: deps.db, log: deps.log, hub: deps.hub, sessions: new SessionTracker(deps.db, deps.client) });
  return { ...reel, relayOnce: async () => "ok" };
};

const decisionsDuJournal = (h: CockpitHarness): Array<{ verdict: string; regle: string }> =>
  h.db.prepare("SELECT verdict, regle FROM autonomy_decisions ORDER BY id").all() as Array<{ verdict: string; regle: string }>;

/** Signe dessiné d'un verdict (neon-scene.ts, DECISION_SIGNS) : bouclier pour « auto », croix pour un refus du cockpit. */
const SIGNE_DU_VERDICT: Readonly<Record<string, "auto" | "refus">> = { auto: "auto", "refus-auto": "refus", "refus-interdit": "refus" };

describe("croisements 3d-fusion : it2 × 3D (autonomie-p8.jsonl, câblage complet)", () => {
  it("« Revoir » d'une conversation autonome de l'instance principale → 200 en Simple, zéro requête à opencode et zéro ligne usage ; « différé = direct » du plan 3D ; un signe 3D par décision signée", async (t) => {
    const h = await demarrer(t, {
      settings: { ui: { mode: "simple" }, budget: { autonomie: { controleIa: true, actionsMax: 1 } } },
      // Même surcharge que le croisement it2 V3 : la conversation de la capture n'est pas créée par le cockpit (plancher non posé).
      ports: { activation: { check: async () => ({ ok: true }) } },
      gate: RELAIS_OK,
    });
    const capture = readCapture("autonomie-p8.jsonl");
    const creee = capture.find(({ wire }) => "payload" in wire && !("syncEvent" in wire.payload) && wire.payload.type === "session.created");
    assert.ok(creee && "payload" in creee.wire && !("syncEvent" in creee.wire.payload), "la capture crée une conversation");
    const proprietes = creee.wire.payload.properties;
    assert.ok(isRecord(proprietes) && isRecord(proprietes.info) && typeof proprietes.info.id === "string");
    const rootId = proprietes.info.id;
    h.fake.emitRaw(creee.wire);
    await until(() => h.sessions.get(rootId));
    const choix = await h.call("PUT", `/api/conversations/${rootId}/autonomie`, { headers: h.headers.confirmed, body: { choix: "autonome" } });
    assert.equal(choix.status, 200, choix.body);
    h.db
      .prepare("INSERT INTO autonomy_requests (id, root_id, choix, plafonds, started_at) VALUES ('gf2', ?, 'autonome', ?, ?)")
      .run(rootId, JSON.stringify({ plafondUsd: 1, actionsMax: 1, delegationsMax: 5, dureeMinutes: 30, fichiersMax: 25, controlesIaMax: 20 }), Date.now());
    for (const { wire } of capture) h.fake.emitRaw(wire);
    const journal = await until(() => {
      const lignes = decisionsDuJournal(h);
      return lignes.length === 4 ? lignes : null;
    }, 8_000);
    assert.deepEqual(
      journal.map((ligne) => [ligne.verdict, ligne.regle]),
      [
        ["attente", "E2"],
        ["attente", "S7"],
        ["auto", "A-pwd"],
        ["attente", "plafond-actions"],
      ],
      "les quatre situations de la fixture, inchangées par la salle et la 3D montées en plus",
    );
    // La demande se termine, comme la fixture le fait en « Demander à chaque fois ».
    h.db.prepare("UPDATE autonomy_requests SET ended_at = ? WHERE id = 'gf2'").run(Date.now());

    // « Revoir » en Simple : lecture seule, par la route dédiée de la 3D.
    const avant = h.fake.requests.length;
    const usageAvant = lignesUsage(h);
    const reponse = await h.call("GET", `/api/revoir/${rootId}`, { headers: h.headers.authed });
    assert.equal(reponse.status, 200, reponse.body);
    const revoir = reponse.json<RevoirResponse>();
    assert.equal(revoir.instance, "principale");
    assert.equal(revoir.partial, false);
    const etat = await h.call("GET", `/api/revoir/${rootId}?etat=1`, { headers: h.headers.authed });
    assert.equal(etat.json<RevoirEtatResponse>().acces, true);
    assert.deepEqual(requetes(h.fake.requests, avant), [], "aucune requête à opencode pendant « Revoir »");
    assert.equal(lignesUsage(h), usageAvant, "aucune ligne usage pendant « Revoir »");

    // Faits relus par « Revoir » = faits de la route du Déroulé (le même magasin, sans passer par /facts en Simple).
    const faits = revoir.facts;
    const decisions = faits.map((fait, index) => ({ fait, index })).filter(({ fait }) => fait.kind === "decision");
    assert.equal(decisions.length, journal.length, "un fait « decision » par ligne du Journal");

    // « Différé = direct » du plan 3D, à chaque moment, dans les deux modes.
    const tous = moments(faits);
    assert.ok(tous.length > 0, "la fixture a des moments");
    for (const t of tous) {
      const prefixe = faits.slice(0, visibleCount(faits, t));
      for (const vue of [AVANCE, SIMPLE]) assert.deepEqual(planDe(faits, t, vue), planDe(prefixe, null, vue), `moment ${t}, ${vue.mode}`);
    }

    // Chaque décision signée est dessinée en 3D juste après son fait : bouclier (« auto ») ou croix (refus), avec ce fait (P12).
    const signees = decisions.filter(({ fait }) => SIGNE_DU_VERDICT[String(fait.data.verdict)] !== undefined);
    assert.ok(signees.length >= 1, "la fixture porte au moins une décision automatique (A-pwd)");
    for (const { fait, index } of signees) {
      const signe = SIGNE_DU_VERDICT[String(fait.data.verdict)];
      const marques = planDe(faits.slice(0, index + 1), null, AVANCE).marques.filter((marque) => marque.kind === signe);
      assert.ok(
        marques.some((marque) => marque.faits.includes(index)),
        `décision ${String(fait.ref)} (${String(fait.data.verdict)}) sans son signe 3D`,
      );
    }
    assert.equal(NEON_GRAMMAIRE.auto.forme, "bouclier-coche");
    assert.equal(NEON_GRAMMAIRE.refus.forme, "croix");
    h.assertNoGlobalRestart();
  });

  it("croix : un refus du cockpit (refus-auto) est dessiné en 3D comme une croix, sur le même chemin que le bouclier", () => {
    const R = "ses_gf2_croix";
    const faits: ActivityFact[] = [
      { rootId: R, sessionId: R, kind: "origine", ref: "msg_gf2", data: { origine: "demande", cas: 1, messageId: "msg_gf2" }, at: 1_010 },
      { rootId: R, sessionId: R, kind: "statut", ref: null, data: { etat: "occupee" }, at: 1_020 },
      { rootId: R, sessionId: R, kind: "decision", ref: "per_gf2", data: { verdict: "refus-auto", regle: "S1", par: "cockpit" }, at: 1_030 },
    ];
    const marques = planDe(faits, null, AVANCE).marques.filter((marque) => marque.kind === "refus");
    assert.equal(marques.length, 1);
    assert.deepEqual(marques[0]?.faits, [2]);
    assert.equal(marques[0]?.jeton, NEON_GRAMMAIRE.refus.trait);
  });
});

// --- 2. Salle × 3D -------------------------------------------------------------------------------------------------------------

describe("croisements 3d-fusion : salle × 3D (enceinte, bande, vue Simple)", () => {
  it("enceinte 2D (L25b) et 3D du zoom 1 : le même texte, et chacune dessinée pour une racine de la salle en Avancé", () => {
    assert.equal(NEON.avance.salle, SALLE3D.avance.enceinte, "bandeau de l'enceinte : un seul texte, en 2D comme en 3D");
    assert.match(lire("web/pages/chat/activity/NeonBand.tsx"), /<p className="neon-salle">\{TEXTES\.avance\.salle\}<\/p>/);
    assert.match(lire("web/pages/salle-controle/SalleControlePage.tsx"), /\{advanced \? TEXTES\.avance\.enceinte : TEXTES\.simple\.enceinte\}/);
    // 2D : la scène de la fixture de la salle a son enceinte (mode Avancé).
    assert.notEqual(scene(omoFaits(), null, AVANCE).enceinte, null, "enceinte 2D absente");
    // 3D, zoom 1 : une racine de la salle donne l'enceinte du plan des territoires.
    const reponse: TerritoiresResponse = {
      genereLe: 1,
      mode: "avance",
      projets: [{ projet: "proj", nom: "proj", conversations: [], compteurs: { travaillent: 0, attendent: 0, cout: 0 } }],
      salle: { projets: [{ projet: "proj", nom: "proj", conversations: [], compteurs: { travaillent: 1, attendent: 0, cout: 0 } }] },
      statutVerifie: false,
    };
    const plan = planTerritoires(reponse, new Map(), { theme: "sombre", mode: "avance" });
    assert.deepEqual(plan.enceinte, { projets: ["proj"] });
    assert.ok(plan.territoires.some((territoire) => territoire.enceinte), "territoire de l'enceinte absent du zoom 1");
  });

  it("zoom 1 en Simple : aucune étiquette d'état ni compteur pour l'enceinte de la salle", () => {
    const reponse: TerritoiresResponse = {
      genereLe: 1,
      mode: "simple",
      projets: [],
      salle: { projets: [{ projet: "proj", nom: "proj", conversations: [], compteurs: { travaillent: null, attendent: 0, cout: 0 } }] },
      statutVerifie: false,
    };
    const plan = planTerritoires(reponse, new Map(), { theme: "sombre", mode: "simple" });
    const etiquette = plan.etiquettes.find((e) => e.cible === "salle:proj");
    assert.ok(etiquette, "étiquette du territoire de la salle");
    assert.equal(etiquette.etat, null, "D-3d-14 : en Simple, l'enceinte ne montre aucun état en direct");
  });

  it("bande d'une racine de la salle : [Revoir cette demande] en Avancé, aucune commande en Simple (BandCommands3d dans NeonBand)", () => {
    const faits = omoFaits();
    // racineDeLaSalle (BandCommands3d.tsx) : le fait `statut` de la racine porte son instance ; la fixture de la salle la porte.
    assert.ok(
      faits.some((fait) => fait.sessionId === OMO_RACINE && fait.data.instance === "omo"),
      "la fixture de la salle doit être reconnue comme telle par la bande",
    );
    const commandes = lire("web/pages/salle-controle/revoir/BandCommands3d.tsx");
    assert.match(commandes, /return facts\.some\(\(fait\) => fait\.sessionId === rootId && fait\.data\.instance === "omo"\);/);
    assert.match(commandes, /const salleEnSimple = !advanced && racineDeLaSalle\(facts, rootId\);/);
    assert.match(commandes, /if \(salleEnSimple\) return null;/);
    assert.match(commandes, /\{TEXTES_REVOIR\.partout\.revoir\}/);
    assert.equal(REVOIR.partout.revoir, "Revoir cette demande");
    const bande = lire("web/pages/chat/activity/NeonBand.tsx");
    assert.match(bande, /<BandCommands3d rootId=\{rootId\} facts=\{facts\} advanced=\{advanced\} \/>/, "la bande passe son mode aux commandes 3D");
    assert.match(bande, /export function NeonCarte\(/);
    assert.match(bande, /export function NeonTableau\(/);
  });

  it("vue Simple de « Revoir » sur omo-jp1-jp7.jsonl : assistants dessinés, aucun nom d'agent à l'écran", () => {
    const faits = omoFaits();
    const permis = new Set<string>([REVOIR.simple.assistantPrincipal, ...NEON_SECTEURS.map((secteur) => libelleSecteur(secteur))]);
    const nomsDeLaFixture = [...new Set(scene(faits, null, AVANCE).noeuds.map((noeud) => noeud.agent ?? "").filter((nom) => nom !== ""))];
    assert.ok(nomsDeLaFixture.length >= 2, "la fixture doit porter des noms d'agent, sinon la garde ne prouve rien");
    const mode = modeSceneRevoir({ salle: true, advanced: false });
    let vus = 0;
    for (const t of moments(faits)) {
      const brute = scene(faits, t, { zoom: 2, mode });
      if (brute.noeuds.length < 2) continue;
      vus += 1;
      const vue = vueSimple(brute, nomsSimples(brute, true));
      assert.equal(vue.mode, "simple");
      const montre = [
        ...lignesTableau(vue).flatMap((ligne) => [ligne.nom, ligne.secteur ?? "", ligne.etat, ...ligne.signes]),
        ...vue.noeuds.map((noeud) => libelleNoeud(noeud)),
      ].join(" | ");
      for (const nom of nomsDeLaFixture) assert.equal(montre.includes(nom), false, `nom d'agent montré : ${nom}`);
      assert.equal(/agent|orchestrateur/i.test(montre), false, montre);
      for (const noeud of vue.noeuds) assert.ok(noeud.agent !== null && permis.has(noeud.agent), `nom montré : ${noeud.agent}`);
    }
    assert.ok(vus > 0, "aucun moment de la fixture ne dessine deux assistants");
  });

  it("proxy de la salle en Simple : refusé même salle ouverte (« mode-avance ») ; salle coupée : « salle-coupee »", () => {
    const ouverte = { salleOuverte: true, omoActif: true, instancePresente: true };
    assert.equal(refusMontageSalle({ ...ouverte, mode: "simple" }), "mode-avance");
    assert.equal(refusMontageSalle({ ...ouverte, mode: "avance" }), null);
    assert.equal(refusMontageSalle({ ...ouverte, salleOuverte: SALLE_OUVERTE, mode: "avance" }), "salle-coupee");
  });
});

describe("croisements 3d-fusion : salle × « Revoir » sur le cockpit réel (Q6, P11, U2)", () => {
  it("Simple : /facts et /activity → 403 ; « Revoir » et consigne gardée d'une demande terminée → 200 (troncature dite), en cours → 403 ; Avancé → 200 ; envoi et réponse d'autorisation refusés ; zéro requête aux deux instances, zéro ligne usage", async (t) => {
    const h = await startCockpit(t, { modules: "tous", omo: true });
    assert.ok(h.omo);
    const faits = omoFaits();
    assert.equal(occupeesSelonFaits(faits, false), 0, "la fixture de la salle finit au repos");
    poserRacine(h, OMO_RACINE, "omo");
    poserDemande(h, "aur_gf2_salle", OMO_RACINE, true);
    h.cockpit.c11.ports.facts.append(faits);
    const store = createConsignesStore(h.db);
    const longueur = 12_345;
    const brut = `[synthétique] ${"x".repeat(longueur - 14)}`;
    assert.equal(pointsDeCode(brut), longueur);
    assert.equal(store.enregistrer({ rootId: OMO_RACINE, parent: OMO_RACINE, enfant: "ses_jp_fond", callId: "call_gf2_long", brut, at: 1_000 }), "enregistree");

    const avantPrincipale = h.fake.requests.length;
    const avantSalle = h.omo.fake.requests.length;
    const usageAvant = lignesUsage(h);

    // Simple : les routes de l'activité restent fermées à la salle (L18c, A11) ; « Revoir » passe par sa route dédiée.
    for (const route of ["facts?since=0", "activity"]) {
      const refus = await h.call("GET", `/api/conversations/${OMO_RACINE}/${route}`, { headers: h.headers.authed });
      assert.equal(refus.status, 403, `${route} : ${refus.body}`);
    }
    const revoir = await h.call("GET", `/api/revoir/${OMO_RACINE}`, { headers: h.headers.authed });
    assert.equal(revoir.status, 200, revoir.body);
    const lu = revoir.json<RevoirResponse>();
    assert.equal(lu.instance, "omo");
    assert.equal(lu.termine, true);
    assert.equal(lu.facts.length, faits.length, "faits de la salle relus en entier");

    // [Voir la consigne] : copie gardée, bornée, avec la mention de troncature (U2) ; jamais un texte redemandé.
    const consigne = await h.call("GET", `/api/revoir/${OMO_RACINE}/consignes/call_gf2_long`, { headers: h.headers.authed });
    assert.equal(consigne.status, 200, consigne.body);
    const gardee = consigne.json<RevoirConsigneResponse>();
    assert.equal(gardee.tronque, true);
    assert.equal(gardee.longueur, longueur);
    assert.equal(pointsDeCode(gardee.texte), CONSIGNES.maxCaracteres);
    const mention = libelleConsigneTronquee(pointsDeCode(gardee.texte), gardee.longueur);
    assert.match(mention, /^Consigne tronquée : /);
    assert.ok(mention.replace(/[^0-9]/g, "").startsWith("8000"), mention);
    assert.ok(mention.replace(/[^0-9]/g, "").endsWith("12345"), mention);
    // Les autres textes de message ne sont jamais relus en différé.
    const panneau = { consigne: { messageId: "msg_jp_consigne_fond", faits: [0] }, actions: { termines: 0, faits: [] }, resultat: null, reponse: { messageId: "msg_jp_reponse", faits: [1] }, metadonnees: null };
    assert.deepEqual(textesPanneau(false, panneau), { aRelire: [], nonAffiche: true, consigneGardee: true });
    assert.equal(REVOIR.partout.texteNonAffiche, "Texte non affiché pendant « Revoir » : rien n'est redemandé ni relancé.");

    // Demande en cours : « Revoir » et la consigne se ferment ensemble (Q6), en Simple.
    h.db.prepare("UPDATE autonomy_requests SET ended_at = NULL WHERE id = 'aur_gf2_salle'").run();
    for (const route of [`/api/revoir/${OMO_RACINE}`, `/api/revoir/${OMO_RACINE}/consignes/call_gf2_long`]) {
      const refus = await h.call("GET", route, { headers: h.headers.authed });
      assert.equal(refus.status, 403, `${route} : ${refus.body}`);
      assert.equal((refus.json() as { code?: string }).code, "salle-demande-en-cours");
    }

    // Envoi et réponse d'autorisation vers la salle : refusés, rien de relayé (salle coupée ; en Simple, « mode-avance » ensuite).
    const envoi = await h.call("POST", `/api/omo/oc/session/${OMO_RACINE}/prompt_async?directory=${encodeURIComponent("/workspace/proj")}`, {
      headers: h.headers.mutating,
      body: { parts: [{ type: "text", text: "Continue." }] },
    });
    assert.equal(envoi.status, 403, envoi.body);
    const reponseAccord = await h.call("POST", "/api/omo/oc/permission/per_jp_gf2/reply", { headers: h.headers.mutating, body: { reply: "once" } });
    assert.equal(reponseAccord.status, 403, reponseAccord.body);
    // Montage principal : une racine de la salle n'y existe pas (P11, cloison des instances).
    const croise = await h.call("POST", `/api/oc/session/${OMO_RACINE}/prompt_async?directory=${encodeURIComponent("/workspace/proj")}`, {
      headers: h.headers.mutating,
      body: { parts: [{ type: "text", text: "Continue." }] },
    });
    assert.equal(croise.status, 404, `envoi croisé : ${croise.body}`);
    assert.equal((croise.json() as { error?: string }).error, "not-found");

    // Avancé : « Revoir » d'une demande en cours de la salle est permis (lecture seule).
    h.settings.update({ ui: { mode: "avance" } });
    const avance = await h.call("GET", `/api/revoir/${OMO_RACINE}`, { headers: h.headers.authed });
    assert.equal(avance.status, 200, avance.body);

    assert.deepEqual(requetes(h.fake.requests, avantPrincipale), [], "aucune requête à l'instance principale");
    assert.deepEqual(requetes(h.omo.fake.requests, avantSalle), [], "aucune requête à la salle");
    assert.equal(lignesUsage(h), usageAvant, "aucune ligne usage");
  });

  it("territoires en Simple : enceinte sans compteur, seules les demandes terminées ; P11 : aucun dossier de la salle demandé à l'instance principale", async (t) => {
    const h = await startCockpit(t, { modules: "tous", omo: true });
    assert.ok(h.omo);
    poserRacine(h, OMO_RACINE, "omo");
    poserDemande(h, "aur_gf2_terr", OMO_RACINE, true);
    h.cockpit.c11.ports.facts.append(omoFaits());
    poserRacine(h, "ses_gf2_salle_en_cours", "omo");
    poserDemande(h, "aur_gf2_terr_2", "ses_gf2_salle_en_cours", false);

    const avantPrincipale = h.fake.requests.length;
    const avantSalle = h.omo.fake.requests.length;
    const reponse = await h.call("GET", "/api/salle-controle/territoires", { headers: h.headers.authed });
    assert.equal(reponse.status, 200, reponse.body);
    const vue = reponse.json<TerritoiresResponse>();
    assert.equal(vue.mode, "simple");
    assert.ok(vue.salle, "enceinte présente dès qu'une racine de la salle existe (JP-10)");
    const conversations = vue.salle.projets.flatMap((territoire) => territoire.conversations);
    assert.deepEqual(
      conversations.map((c) => c.rootId),
      [OMO_RACINE],
      "en Simple, seule la demande terminée est listée",
    );
    for (const c of conversations) {
      assert.equal(c.travaillent, null, "aucun compteur en direct de la salle en Simple");
      assert.equal(c.attendent, 0);
      assert.equal(c.coutEnCours, 0);
      assert.equal(c.revoir, true);
    }
    assert.equal(vue.statutVerifie, false);
    // P11 : aucune racine principale ici, donc AUCUN GET /session/status ; la salle n'est jamais interrogée par les territoires.
    assert.deepEqual(requetes(h.fake.requests, avantPrincipale), [], "aucune requête à l'instance principale");
    assert.deepEqual(requetes(h.omo.fake.requests, avantSalle), [], "aucune requête à la salle");
  });

  it("consignes (U2) : capture sur le processeur PRINCIPAL malgré le filtre d'instance de T3b ; événements de la salle capturés par le processeur de la salle seulement (L3s-a) ; purge → faits et consignes ensemble", async (t) => {
    const h = await startCockpit(t, { modules: "tous", omo: true });
    assert.ok(h.omo);
    const PRINCIPALE = "ses_gf2_principale";
    const ENFANT = "ses_gf2_enfant";
    const SALLE = "ses_gf2_salle";
    poserRacine(h, PRINCIPALE, "principale");
    poserRacine(h, SALLE, "omo");
    const tache = (parent: string, callId: string, enfant: string) => ({
      type: "message.part.updated",
      properties: {
        part: {
          id: `prt_${callId}`,
          type: "tool",
          tool: "task",
          sessionID: parent,
          messageID: `msg_${callId}`,
          callID: callId,
          state: { status: "running", input: { prompt: "[synthétique] consigne confiée", subagent_type: "explore" }, metadata: { sessionId: enfant } },
        },
      },
    });

    h.fake.emit(tache(PRINCIPALE, "call_gf2_principale", ENFANT), "/workspace/proj");
    await until(() => compter(h, "revoir_consignes", PRINCIPALE) === 1 || null, 5_000);
    // Même événement sur l'instance de la salle, traité par SON processeur : depuis « 3s » (L3s-a), la dérivation y est inscrite
    // aussi ; la consigne est gardée sous la racine de la salle, et rien ne passe par le processeur principal (adaptation de
    // L3s-a : avant, rien n'était gardé pour la salle).
    await h.emitOmo({ directory: "/workspace/proj", payload: { id: "evt_gf2_salle", ...tache(SALLE, "call_gf2_salle", "ses_gf2_enfant_salle") } });
    assert.equal(compter(h, "revoir_consignes", SALLE), 1);
    assert.equal(compter(h, "revoir_consignes", PRINCIPALE), 1);

    // Purge (conversation-purge.ts, ligne [3d]) : faits et consignes partent ensemble, pour la principale comme pour la salle.
    const store = createConsignesStore(h.db);
    assert.equal(store.enregistrer({ rootId: SALLE, parent: SALLE, enfant: null, callId: "call_gf2_salle_2", brut: "[synthétique] consigne de la salle", at: 1 }), "enregistree");
    for (const rootId of [PRINCIPALE, SALLE]) {
      h.cockpit.c11.ports.facts.append([{ rootId, sessionId: rootId, kind: "statut", ref: null, data: { etat: "occupee" }, at: 10 }]);
      assert.ok(compter(h, "activity_facts", rootId) > 0);
      assert.ok(compter(h, "revoir_consignes", rootId) > 0);
    }
    purgeConversation(h.db, PRINCIPALE);
    assert.equal(compter(h, "activity_facts", PRINCIPALE), 0);
    assert.equal(compter(h, "revoir_consignes", PRINCIPALE), 0);
    assert.ok(compter(h, "revoir_consignes", SALLE) > 0, "la purge d'une conversation ne touche pas les autres");
    purgeConversation(h.db, SALLE);
    assert.equal(compter(h, "activity_facts", SALLE), 0);
    assert.equal(compter(h, "revoir_consignes", SALLE), 0);
  });
});

// --- 4. Migrations (A2, A2 bis ; plan it5 §8.5) ----------------------------------------------------------------------------------

const userVersion = (db: DatabaseSync): number => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
const instructions = (sql: string): string[] =>
  sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
const tables = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
/**
 * Titres de tests (`it`, `describe`, `test`) qui écrivent un numéro de `user_version`. La règle d'assertion unique (A2 bis) vaut
 * aussi pour eux : un titre qui annonce la version 6 sur une assertion à `MIGRATIONS.length` (8 après GF2) envoie le diagnostic
 * d'un échec vers la mauvaise migration (relecture F1-vague-0). Le contrôle `git grep -nE "user_version [0-9]"` sur les tests
 * reste vide : les témoins ci-dessous composent leur nombre.
 */
function titresAVersionEcrite(source: string): string[] {
  const titres: string[] = [];
  for (const m of source.matchAll(/\b(?:it|describe|test)\(\s*(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
    const titre = m[2] ?? "";
    if (/user_version\s*=?\s*\d/.test(titre)) titres.push(titre);
  }
  return titres;
}

describe("croisements 3d-fusion : migrations après GF2 (A2, A2 bis)", () => {
  it("MIGRATIONS : 1 à 5, vraie 6 de la salle, 7 réservée vide, 8 de la 3D ; base neuve à MIGRATIONS.length, omo_rooms et revoir_consignes ensemble", () => {
    assert.match(MIGRATIONS[5] ?? "", /CREATE TABLE omo_rooms/);
    assert.deepEqual(instructions(MIGRATIONS[6] ?? "x"), [], "entrée 7 réservée vide");
    assert.match(MIGRATIONS[7] ?? "", /CREATE TABLE revoir_consignes/);
    assert.equal(MIGRATIONS.at(-1), MIGRATIONS[7], "la 8 est la dernière");
    const db = openMemoryDb();
    try {
      assert.equal(userVersion(db), MIGRATIONS.length);
      const presentes = tables(db);
      for (const table of ["omo_rooms", "omo_room_starts", "revoir_consignes"]) assert.ok(presentes.includes(table), table);
    } finally {
      db.close();
    }
  });

  it("montée depuis 5, depuis 6 (ligne omo_rooms gardée) et depuis 7 : MIGRATIONS.length, rien de perdu", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-3d-fusion-migrations-"));
    try {
      for (const depuis of [5, 6, 7]) {
        const sous = path.join(dir, `v${depuis}`);
        fs.mkdirSync(sous);
        const vieille = new DatabaseSync(path.join(sous, "cockpit.db"));
        vieille.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
        for (let v = 0; v < depuis; v++) {
          transaction(vieille, () => {
            vieille.exec(MIGRATIONS[v] ?? "");
            vieille.exec(`PRAGMA user_version = ${v + 1}`);
          });
        }
        vieille
          .prepare("INSERT INTO sessions (id, parent_id, root_id, created_at, updated_at) VALUES (?, NULL, ?, 1, 1)")
          .run(`ses_m${depuis}`, `ses_m${depuis}`);
        if (depuis >= 6) vieille.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, 'proj', 1)").run(`ses_m${depuis}`);
        assert.equal(userVersion(vieille), depuis);
        vieille.close();

        const db = openDb(sous);
        try {
          assert.equal(userVersion(db), MIGRATIONS.length, `montée depuis ${depuis}`);
          assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n, 1);
          assert.equal((db.prepare("SELECT COUNT(*) AS n FROM omo_rooms").get() as { n: number }).n, depuis >= 6 ? 1 : 0);
          assert.equal((db.prepare("SELECT COUNT(*) AS n FROM revoir_consignes").get() as { n: number }).n, 0);
        } finally {
          db.close();
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aucun titre de test n'écrit un numéro de user_version : il dirait une version que l'assertion ne vérifie plus (A2 bis)", () => {
    const serveur = path.join(APP_DIR, "server");
    const fautifs: string[] = [];
    for (const relatif of fs.readdirSync(serveur, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".test.ts"))) {
      for (const titre of titresAVersionEcrite(fs.readFileSync(path.join(serveur, relatif), "utf8"))) fautifs.push(`${relatif} : ${titre}`);
    }
    assert.deepEqual(fautifs, []);
    // Témoins : la règle voit le défaut, et laisse passer un titre sans nombre.
    const six = String(6);
    assert.deepEqual(titresAVersionEcrite(`it(${DQ}openMemoryDb atteint user_version ${six} avec item_meta${DQ}, () => {`), [`openMemoryDb atteint user_version ${six} avec item_meta`]);
    assert.deepEqual(titresAVersionEcrite(`describe('base', () => { it(${DQ}l'ENV : user_version = 7${DQ}, f); });`), ["l'ENV : user_version = 7"]);
    assert.deepEqual(titresAVersionEcrite(`it(${DQ}openMemoryDb atteint la dernière migration (user_version = MIGRATIONS.length)${DQ}, f)`), []);
  });
});

// --- 5. Contrôles de la fusion -----------------------------------------------------------------------------------------------------

/** Têtes relues de la grande fusion (plan it5 §8.1, décisions) : HS (salle) et H3 (3D). */
const HS = "7d8edcdd031d867045b1853eb6816dc0b43b4627";
const H3 = "b325e73364fcfc173b0ce93d702c2a39b8f366e8";

function git(...args: string[]): string {
  return execFileSync("git", ["-C", DEPOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Les deux têtes sont-elles lisibles ici ? (une copie exportée sans .git ne peut pas vérifier ce qu'a touché la 3D) */
function tetesLisibles(): boolean {
  try {
    git("cat-file", "-e", `${HS}^{commit}`);
    git("cat-file", "-e", `${H3}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

describe("croisements 3d-fusion : contrôles de la fusion", () => {
  it("SALLE_OUVERTE reste fausse ; three@0.186.0 seul ajout (devDependencies) ; garde de three branchée au build", () => {
    assert.equal(SALLE_OUVERTE, false);
    const paquet = JSON.parse(lire("package.json")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    assert.equal(paquet.devDependencies?.three, "0.186.0");
    assert.equal(paquet.dependencies?.three, undefined);
    assert.match(lire("vite.config.ts"), /plugins: \[react\(\), threeGuard\(\)\]/);
    for (const garde of ["server/p8-dependances.test.ts", "server/omo-p13.test.ts", "server/three-guard.test.ts"]) {
      assert.ok(fs.existsSync(path.join(APP_DIR, garde)), `${garde} présent`);
    }
  });

  it("contrôles de mouvement et de textes : les dossiers des deux branches existent, aucun parcours n'est sauté", () => {
    for (const dossier of ["web/pages/omo", "web/pages/salle-controle", "web/pages/salle-controle/revoir"]) {
      assert.ok(fs.statSync(path.join(APP_DIR, dossier)).isDirectory(), dossier);
    }
    assert.match(lire("server/web-animations.test.ts"), /"pages\/omo"/);
    assert.match(lire("server/salle3d-animations.test.ts"), /const SALLE = "pages\/salle-controle";/);
    for (const textes of ["server/textes.test.ts", "server/textes-3d.test.ts", "server/omo-room-texts.test.ts"]) {
      assert.ok(fs.existsSync(path.join(APP_DIR, textes)), textes);
    }
  });

  it(
    "wiring-11.ts et wiring-11.test.ts inchangés par la 3D (H3 depuis sa base commune avec HS)",
    { skip: tetesLisibles() ? false : "têtes HS et H3 illisibles ici (copie sans historique)" },
    () => {
      const base = git("merge-base", HS, H3);
      const touches = git("diff", "--name-only", base, H3, "--", "app/server/wiring-11.ts", "app/server/wiring-11.test.ts");
      assert.equal(touches, "", "la 3D ne touche jamais au registre 1.1 (wiring-3d.ts, hors registre)");
    },
  );
});
