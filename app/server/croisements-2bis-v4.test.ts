// Tests de croisement du train de V4 de la Salle OMO, itération 2 ter (plan d'exécution 2 bis-2 ter §2.3, §5.2 ; propriété de
// l'intégrateur) : L22c (activation et plafond saisi), L22d (répondeur, plafonds, fin de demande), L23b (stopTreeOmo et salle hors
// demande), L23c (détections en service), L25b (réducteur, scène, enceinte), L21b (banc complet).
//
// Chaque paquet a prouvé son service avec des ESPIONS à la place de ses voisins. Ici, AUCUN voisin n'est un espion : l'atelier
// installe les VRAIS services de la vague (activation, répondeur, plafonds, arrêt, détections) sur les VRAIS services des vagues
// d'avant (contrôle L17b, salles L18c, pré-contrôle L19b, proxy de la salle L18b, processeur de la salle L18a), deux faux opencode
// et un superviseur SIMULÉ qui n'ouvre opencode qu'aux conditions du vrai (battement frais du cockpit, `precheck-ok` de CE
// démarrage) et ne publie « arret » qu'à un `stop-request` de ce démarrage. La porte `SALLE_OUVERTE` reste FAUSSE dans le dépôt :
// une vue du `c11` dont la seule porte est ouverte sert aux modules de l'atelier, sans toucher à la constante.
//
// Ce que la vague doit prouver ENSEMBLE (§5.2, ligne V4), et qu'aucun paquet ne peut prouver seul :
//   1. activation confirmée → UN seul envoi → répondeur (« once », refus retenu d'un interdit) → plafond atteint → guard-state.json
//      écrit → stopTreeOmo (zéro POST …/command) → demande close → second envoi refusé → nouvelle confirmation, après la relance ;
//      P6 limité à l'instance principale (ni rechargement, ni dispose, ni configuration, d'un côté comme de l'autre) ;
//   2. réponse non émise par le cockpit (un programme répond « once » à un interdit que le répondeur retient) → arrêt en 5 s au plus ;
//   3. fin de demande → relance à neuf (stop-request « fin-de-demande », boulder.json NON renommé), puis nouvelle demande ;
//   4. redémarrage du cockpit pendant une délégation → stop-request « redemarrage-cockpit », demande « interrompue », aucun appel
//      qui écrive à la salle après la reprise, nouvelle confirmation exigée ;
//   5. activité hors demande → arrêt ; deux en 10 min → suspendue ; réouverture confirmée → levée, et la salle REDÉMARRE ;
//   6. `.git` créé pendant une demande → quarantaine AVANT l'arrêt, `.git` protégé jamais touché ;
//   7. « différé = direct » sur les faits que les vrais services écrivent, et l'action de l'extension sans demande (L23c) lue par
//      le réducteur et la scène (L25b) : boucle orange, jamais un signe du cockpit ;
//   8. le dépôt tel qu'il est livré (modules « tous », SALLE_OUVERTE fausse) : aucun service de la vague n'est construit, aucun
//      battement, aucun fichier dans les volumes de la salle, même après le démarrage ;
//   9. arrêt non confirmé (L23b coupe le battement, l'homme mort arrête la salle) → le démarrage suivant ne peut pas être lancé ;
//      la réouverture confirmée reprend le battement et la salle redémarre ;
//  10. la page de la salle (L26a) envoie avec l'IA de l'assistant de la salle, un seul renvoi sur 409 « assistant-model-changed »,
//      par le proxy de la salle dont `enforceTurn` exige l'IA (constat n° 2 de L21b) ;
//  11. l'écran Budget n'envoie jamais `budget.omo`, que L22c rend non inscriptible (remarque n° 6 de L22c).
// Le banc complet à blanc est joué par omo-banc-complet.test.ts (L21b) et, au train, par run-banc.mjs --complet --a-blanc.
//
// Défauts de croisement trouvés par ce train, corrigés avec lui (chacun tombe ici sans sa correction) :
//   - aucun code de production n'appelait `omoControl.startHeartbeat()` (constats de L23b et L21b) : omo-control-module.ts le lance au
//     démarrage, omo-room.ts le reprend à la réouverture (croisements 1 et 5 : le superviseur simulé exige un battement frais) ;
//   - une salle suspendue ne pouvait JAMAIS être levée : la réouverture créait la racine sur un opencode que le superviseur n'avait
//     pas lancé (aucun precheck-ok sous suspension, surveillance de L19b qui ne revient pas sur un démarrage vu) et ne levait la
//     suspension qu'après (croisement 5) ;
//   - L23c écrivait le fait « decision » d'une action sans demande SANS `par: "extension"`, la seule marque que L25b lit : la boucle
//     orange n'était jamais dessinée (croisement 7) ;
//   - la page de la salle envoyait `{ parts }` seul : 400 « modele-requis », aucun message ne pouvait partir (croisement 10) ;
//   - l'écran Budget renvoyait tout le bloc `budget`, `omo` compris : un brouillon ouvert avant une activation recevait 403
//     « reglage-fixe » (croisement 11).
// Aucun conteneur, aucun appel Copilot, aucune pause fixe hors des bornes mesurées (5 s de G13).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { type Context, Hono } from "hono";
import type { CatalogModel, CatalogSources } from "./catalog.ts";
import type { Cockpit11, Cockpit11Module, OmoControlDirs } from "./contracts-11.ts";
import { PortUnavailableError } from "./contracts-11.ts";
import { ConversationAutonomyStore } from "./conversation-autonomy.ts";
import { forbiddenCommandArguments, forbiddenProxyBody, turnModelFromBody } from "./http.ts";
import { createOcProxy, PROXY_RULES_OMO } from "./oc-proxy.ts";
import { installOmoActivation, OMO_IMAGE_ID_PREFIXE } from "./omo-activation.ts";
import { installOmoCaps, type OmoCapsService } from "./omo-caps.ts";
import type { OmoControlClock, OmoControlService } from "./omo-control.ts";
import { omoControlModule } from "./omo-control-module.ts";
import { inscrireDetectionsSalle, OMO_DETECTIONS_BORNE_MS, OMO_OUTILS_SANS_DEMANDE, type OmoDetectionsService, type OmoHorsControleData } from "./omo-detections-service.ts";
import { createOmoPrecheckService } from "./omo-precheck-service.ts";
import { installOmoResponder, messageInterdit, type OmoResponderService } from "./omo-responder.ts";
import { omoRoomModule } from "./omo-room.ts";
import { creerModuleOmoStop } from "./omo-stop.ts";
import type { OcGlobalEvent, OcSession } from "./opencode.ts";
import { activityStatus, applyEvent, emptyActivity, liveRows, replayFacts, timeline, totals } from "./shared/activity.ts";
import type { ActivityFact } from "./shared/activity-types.ts";
import type { OmoAutonomyView } from "./shared/api-types.ts";
import { scene } from "./shared/neon-scene.ts";
import {
  analyserArret,
  analyserBattement,
  analyserGuardState,
  analyserPrecheckOk,
  battementFrais,
  ecrireEtat,
  OMO_FICHIER_ETAT,
  OMO_FICHIERS_CONTROLE,
  precheckDuDemarrage,
} from "./shared/omo-control-protocol.ts";
import { OMO_LIMITES } from "./shared/omo-limits.ts";
import { roleDeAgent } from "./shared/omo-roles.ts";
import { phraseRefusActivation } from "./shared/omo-room-texts.ts";
import type { OmoActivationRefusalCode, OmoPreparedProjects, OmoSupervisorPhase, OmoSupervisorState } from "./shared/omo-types.ts";
import { type CallResult, type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { bash, until, within } from "./test-support/helpers.ts";
import { SALLE_OUVERTE } from "./wiring-11.ts";
import { ApiError } from "../web/lib/api.ts";
import { envoyerMessageOmo, envoyerOmo, modeleEnvoiSalle } from "../web/lib/api-omo.ts";

const SHA = "b".repeat(64);
const IMAGE_ID = `${OMO_IMAGE_ID_PREFIXE}base=sha256:${SHA} lock=sha256:${SHA}`;
const START_1 = "5a1e0c4d-2b7f-4e61-9c3a-7d8e0f1a2b31";
const START_2 = "5a1e0c4d-2b7f-4e61-9c3a-7d8e0f1a2b32";
const START_3 = "5a1e0c4d-2b7f-4e61-9c3a-7d8e0f1a2b33";
const ENDPOINT = "https://api.githubcopilot.com";
const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };
const PROJET = "app";

// --- Monde de la salle ---------------------------------------------------------------------------------------------------------

/** Horloge simulée (plafonds : les 15 s de repos de la fin de demande) : aucune minuterie ne part seule ; `avancer` les déclenche dans l'ordre. */
function fausseHorloge(depart = Date.now()) {
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

const projetsPrepares = (): OmoPreparedProjects => ({
  version: 1,
  genereLe: "2026-09-24T08:00:00Z",
  projets: [{ chemin: PROJET, git: "dossier" }],
  gitProteges: [{ chemin: `${PROJET}/.git`, forme: "dossier" }],
});

/** État publié par le superviseur : sonde étendue de L16c verte (racine en lecture seule, projet protégé, aucun montage refusé). */
const etatDe = (startId: string, phase: OmoSupervisorPhase): OmoSupervisorState => ({
  startId,
  phase,
  imageId: IMAGE_ID,
  manifestSha256: SHA,
  manifesteReference: "ok",
  validation: "ok",
  dossiersConfig: [
    { chemin: "/home/node/.config/opencode", ok: true },
    { chemin: "/home/node/.omo", ok: true },
  ],
  projets: [{ chemin: PROJET, gitLectureSeule: true }],
  workspaceGit: { verifieLe: Date.now(), limiteAtteinte: false, nonProteges: [] },
  startedAt: Date.now(),
});

/** Catalogue du compte (P1) : lu, vérifié auprès de GitHub Copilot, à l'adresse d'office, une IA Copilot. */
const modeleCopilot = (): CatalogModel => ({
  key: "github-copilot/gpt-5-mini",
  providerID: "github-copilot",
  providerName: "GitHub Copilot",
  modelID: "gpt-5-mini",
  name: "GPT-5 mini",
  price: null,
  contextLimit: null,
  outputLimit: null,
  reasoning: false,
  attachment: false,
  toolcall: true,
  variants: [],
  status: "active",
});
const catalogue = () => {
  const sources: CatalogSources = {
    opencodeError: null,
    copilotVerified: true,
    copilotError: null,
    endpoint: { url: ENDPOINT, source: "github", plan: null, opencodeDefault: ENDPOINT },
    unavailable: [],
  };
  return { loaded: true, sources, list: () => [modeleCopilot()] };
};

interface Atelier {
  h: CockpitHarness;
  omo: NonNullable<CockpitHarness["omo"]>;
  /** Proxy RÉEL de la salle (/api/omo/oc/*), monté comme dans les tests de L18b et L22c. */
  proxy: Hono;
  workspace: string;
  dirApp: string;
  controlDir: string;
  stateDir: string;
  /** Service de contrôle RÉEL (L17b), posé par le vrai module sur la vue ouverte. */
  control(): OmoControlService;
  horlogeCaps: ReturnType<typeof fausseHorloge>;
  publier(etat: OmoSupervisorState): void;
  etat(): OmoSupervisorState | null;
  /** Nouveau démarrage publié en « attente », pré-contrôlé comme la surveillance de L19b le ferait, puis lancé par le superviseur. */
  demarrer(startId: string): Promise<void>;
  /** Superviseur simulé : lance opencode seulement avec un battement frais du cockpit et le precheck-ok de CE démarrage. */
  lancer(): void;
  /** Superviseur simulé qui n'arrête plus rien (arrêt non confirmé). */
  superviseurMuet(muet: boolean): void;
  /** Démarrage du cockpit, battement attendu sans aucun pilote, puis premier démarrage de la salle. */
  pret(): Promise<void>;
  ouvrir(): Promise<CallResult>;
  ouvrirSalle(): Promise<string>;
  activer(rootId: string, plafondUsd: string): Promise<CallResult>;
  envoyer(rootId: string): Promise<{ status: number; body: Record<string, unknown> | null }>;
  controle(nom: string): string | null;
  /** Requêtes reçues par le faux de la SALLE depuis un repère, « MÉTHODE /chemin ». */
  salle(depuis?: number): string[];
  /** Réponses aux demandes d'autorisation reçues par le faux de la salle : { id, reply, message }. */
  reponses(): Array<{ id: string; reply: unknown; message: unknown }>;
  evenements<T>(type: string): T[];
  ligneDemarrage(startId: string): { cause: string; fin: string } | undefined;
  settled(): Promise<void>;
}

async function atelier(t: TestContext): Promise<Atelier> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "croisement-2ter-v4-"));
  t.after(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Dossier temporaire verrouillé (Windows) : le système le reprendra.
    }
  });
  const workspace = path.join(tmp, "workspace");
  const dirApp = path.join(workspace, PROJET);
  fs.mkdirSync(path.join(dirApp, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dirApp, ".git", "HEAD"), "ref: refs/heads/principale\n", "utf8");
  fs.mkdirSync(path.join(dirApp, "src"), { recursive: true });
  fs.writeFileSync(path.join(dirApp, "src", "index.js"), "// [synthétique] projet de croisement, aucun secret.\n", "utf8");
  fs.writeFileSync(path.join(dirApp, "README.md"), "[synthétique] projet de croisement.\n", "utf8");
  const projectsFile = path.join(tmp, "hote", "omo-projets.json");
  fs.mkdirSync(path.dirname(projectsFile), { recursive: true });
  fs.writeFileSync(projectsFile, `${JSON.stringify(projetsPrepares())}\n`, "utf8");

  const horlogeCaps = fausseHorloge();
  const dirs: { control: string; state: string } = { control: "", state: "" };
  const lireFichier = (chemin: string): string | null => (fs.existsSync(chemin) ? fs.readFileSync(chemin, "utf8") : null);
  const etatPublie = (): OmoSupervisorState | null => {
    const texte = lireFichier(path.join(dirs.state, OMO_FICHIER_ETAT));
    return texte === null ? null : (JSON.parse(texte) as OmoSupervisorState);
  };
  const publier = (etat: OmoSupervisorState) => fs.writeFileSync(path.join(dirs.state, OMO_FICHIER_ETAT), ecrireEtat(etat), "utf8");

  // Superviseur simulé pour la sonde de L23b : un stop-request de CE démarrage → opencode arrêté, « arret » publié (supervisor.sh).
  // « Muet » : il n'arrête rien (opencode qui ne répond plus à TERM) ; la sonde de L23b conclut alors « arrêt non confirmé ».
  const muet = { actif: false };
  const superviseur = async () => {
    if (muet.actif) return new Promise<void>((resolve) => setTimeout(resolve, 5));
    const arret = analyserArret(lireFichier(path.join(dirs.control, OMO_FICHIERS_CONTROLE.arret)));
    const courant = etatPublie();
    if (arret !== null && courant !== null && arret.startId === courant.startId && courant.phase !== "arret") publier({ ...courant, phase: "arret" });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  };

  // Vue du c11 dont la SEULE porte ouverte est SALLE_OUVERTE (et qui connaît la liste des projets préparés d'install.ps1). Les
  // ports sont le même objet que ceux du c11 : chaque service lit ses voisins RÉELS au moment de l'appel.
  let ouvert: Cockpit11 | null = null;
  const vue = (c11: Cockpit11): Cockpit11 => {
    ouvert ??= { ...c11, salleOuverte: true, omoControlDirs: { ...(c11.omoControlDirs as OmoControlDirs), projectsFile } };
    return ouvert;
  };
  const ouvrirModule = (m: Cockpit11Module): Cockpit11Module => ({ name: m.name, install: (reg, c11) => m.install(reg, vue(c11)) });
  let precheck: ReturnType<typeof createOmoPrecheckService> | null = null;
  let repondeur: OmoResponderService | null = null;
  let plafonds: OmoCapsService | null = null;
  let detections: OmoDetectionsService | null = null;

  const modules: Cockpit11Module[] = [
    ouvrirModule(omoControlModule),
    ouvrirModule(omoRoomModule),
    {
      // Pré-contrôle RÉEL de L19b, sans sa veille : `demarrer` l'appelle comme la surveillance de state.json le ferait.
      name: "omoPrecheck",
      install(_reg, c11) {
        const o = vue(c11);
        precheck = createOmoPrecheckService({
          workspace,
          projectsFile,
          db: o.db,
          hub: o.hub,
          log: o.log,
          control: () => o.ports.omoControl,
          room: () => o.ports.omoRoom,
          actif: () => true,
        });
        o.ports.omoPrecheck = precheck;
      },
    },
    // Activation RÉELLE (L22c) : seuls l'image installée par install.ps1 et le catalogue du compte viennent du test.
    { name: "omoActivation", install: (reg, c11) => void installOmoActivation(reg, vue(c11), { image: "opencode-cockpit/opencode-omo:croisement", catalogue }) },
    ouvrirModule(creerModuleOmoStop({ sleep: superviseur, sondeIntervalleMs: 10, sondeFenetreMs: 300 })),
    // Détections RÉELLES (L23c) sur l'horloge réelle : leurs faits portent l'heure vraie, comme en production (« différé = direct »).
    { name: "omoDetections", install: (reg, c11) => void (detections = inscrireDetectionsSalle(reg, vue(c11))) },
    { name: "omoResponder", install: (reg, c11) => void (repondeur = installOmoResponder(reg, vue(c11))) },
    { name: "omoCaps", install: (reg, c11) => void (plafonds = installOmoCaps(reg, vue(c11), { clock: horlogeCaps.clock })) },
  ];

  const h = await startCockpit(t, {
    omo: true,
    modules: ["gate", "facts", "conversationAutonomy", ...modules],
    settings: { ui: { mode: "avance" } },
    env: { workspaceDir: workspace },
  });
  const omo = h.omo;
  assert.ok(omo, "harnais : option « omo »");
  dirs.control = omo.dirs.control;
  dirs.state = omo.dirs.state;
  const control = () => h.cockpit.c11.ports.omoControl as OmoControlService;
  t.after(async () => {
    plafonds?.close();
    detections?.fermer();
    control().stopHeartbeat();
    await control().settled?.();
  });

  // Le serveur de la salle ne répond à une création de racine que si le superviseur a lancé opencode (état « opencode-lance ») :
  // c'est ce qui rend visible, ici, une salle qui ne démarre jamais.
  const client = omo.deps.client;
  const requete = client.request.bind(client);
  client.request = (async (method: string, pathname: string, options?: Parameters<typeof client.request>[2]) => {
    if (method === "POST" && pathname === "/session" && etatPublie()?.phase !== "opencode-lance") throw new TypeError("fetch failed");
    return requete(method, pathname, options);
  }) as typeof client.request;

  // Proxy de la salle monté comme dans les tests de L18b et L22c (le montage de createApp reste fermé, SALLE_OUVERTE fausse). Son
  // contrôle de tour fait ce que celui de http.ts fait avant le relais et dont dépend l'origine du message (L4b, activity-deriver) :
  // la ligne chat_turns de l'envoi. Sans elle, la demande du cockpit serait « origine-inconnue », donc une détection. Sa première
  // règle est celle, RÉELLE, d'enforceTurn (turnModelFromBody de http.ts) : sans IA dans le corps, 400 « modele-requis ».
  const enforceTurn = async (c: Context, sub: string, _directory: string | null, body: string, parsed: unknown) => {
    const [, , sessionId = "", action = ""] = sub.split("/");
    if (action === "prompt_async") {
      if (turnModelFromBody("message", parsed) === undefined) return c.json({ error: "modele-requis", message: "Précisez l'IA de la demande." }, 400);
      h.ledger.recordChatTurn({ session_id: sessionId, created_at: Date.now(), kind: "message", agent: "build", command: null, tier: null, model: `${MODEL.providerID}/${MODEL.modelID}`, variant: null, runs: [] });
    }
    return body;
  };
  const app = new Hono();
  app.all(
    "/api/omo/oc/*",
    createOcProxy({
      env: h.deps.env,
      log: h.deps.log,
      projects: h.deps.projects,
      hooks: h.cockpit.wiring,
      instanceOf: (id: string) => h.sessions.get(id)?.instance ?? null,
      forbiddenProxyBody,
      forbiddenCommandArguments,
      enforceTurn,
      instance: omo.deps,
      prefix: "/api/omo/oc",
      rules: PROXY_RULES_OMO,
    }),
  );

  const controle = (nom: string) => lireFichier(path.join(dirs.control, nom));
  const lancer = () => {
    const etat = etatPublie();
    assert.ok(etat !== null && etat.phase === "attente", "superviseur : un démarrage en attente");
    assert.ok(battementFrais(analyserBattement(controle(OMO_FICHIERS_CONTROLE.battement)), Date.now()), "superviseur : aucun battement frais du cockpit");
    assert.ok(precheckDuDemarrage(analyserPrecheckOk(controle(OMO_FICHIERS_CONTROLE.precheck)), etat.startId, Date.now()), "superviseur : aucun precheck-ok de ce démarrage");
    publier({ ...etat, phase: "opencode-lance" });
  };
  const settled = async () => {
    await omo.deps.processor.settled();
    await h.processor.settled();
    await Promise.all([repondeur?.settled(), plafonds?.settled(), detections?.settled(), precheck?.settled(), control().settled?.()]);
  };

  const a: Atelier = {
    h,
    omo,
    proxy: app,
    workspace,
    dirApp,
    controlDir: dirs.control,
    stateDir: dirs.state,
    control,
    horlogeCaps,
    publier,
    etat: etatPublie,
    lancer,
    superviseurMuet: (valeur) => void (muet.actif = valeur),
    async demarrer(startId) {
      publier(etatDe(startId, "attente"));
      const issue = await (precheck as NonNullable<typeof precheck>).beforeStart(startId);
      assert.equal(issue.ok, true, JSON.stringify(issue));
      lancer();
    },
    async pret() {
      await within(h.cockpit.startup(), "démarrage du cockpit", 10_000);
      // Correction du train : c'est le COCKPIT qui bat (étape de démarrage d'omoControl), aucun pilote n'écrit le battement ici.
      await until(() => controle(OMO_FICHIERS_CONTROLE.battement), 5_000);
      await a.demarrer(START_1);
    },
    ouvrir: () => h.call("POST", "/api/omo/rooms", { headers: h.headers.confirmed, body: { projet: PROJET } }),
    async ouvrirSalle() {
      const res = await a.ouvrir();
      assert.equal(res.status, 200, res.body);
      return res.json<{ rootId: string }>().rootId;
    },
    activer: (rootId, plafondUsd) =>
      h.call("PUT", `/api/conversations/${rootId}/autonomie`, { headers: h.headers.confirmed, body: { choix: "omo", plafondUsd } }),
    async envoyer(rootId) {
      const res = await app.request(`/api/omo/oc/session/${rootId}/prompt_async`, {
        method: "POST",
        body: JSON.stringify({ parts: [{ type: "text", text: "[synthétique] travaille" }], model: MODEL }),
        headers: { "content-type": "application/json" },
      });
      const texte = await res.text();
      return { status: res.status, body: texte === "" ? null : (JSON.parse(texte) as Record<string, unknown>) };
    },
    controle,
    salle: (depuis = 0) => omo.fake.requests.slice(depuis).map((r) => `${r.method} ${r.pathname}`),
    reponses: () =>
      omo.fake.requests
        .filter((r) => r.method === "POST" && /^\/permission\/[^/]+\/reply$/.test(r.pathname))
        .map((r) => ({ id: decodeURIComponent(r.pathname.split("/")[2] ?? ""), reply: (r.body as { reply?: unknown }).reply, message: (r.body as { message?: unknown }).message })),
    evenements: <T>(type: string) =>
      h
        .cockpitEvents()
        .filter((e) => e.type === type)
        .map((e) => e.data as T),
    ligneDemarrage: (startId) => {
      const ligne = h.db.prepare("SELECT cause, fin FROM omo_room_starts WHERE start_id = ?").get(startId) as { cause: string; fin: string } | undefined;
      return ligne === undefined ? undefined : { cause: ligne.cause, fin: ligne.fin };
    },
    settled,
  };
  return a;
}

const envois = (a: Atelier, depuis = 0) => a.salle(depuis).filter((r) => r.startsWith("POST ") && r.endsWith("/prompt_async")).length;
const refusEnvoi = (res: { status: number; body: Record<string, unknown> | null }, code: OmoActivationRefusalCode) => {
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body?.raison, code, JSON.stringify(res.body));
};
const refusPut = (res: CallResult, code: OmoActivationRefusalCode) => {
  assert.equal(res.status, 409, res.body);
  const corps = res.json<{ raison: string; message: string }>();
  assert.equal(corps.raison, code, res.body);
  assert.equal(corps.message, phraseRefusActivation(code).replace("{projet}", PROJET).trim(), res.body);
};
/** Routes qui rechargeraient ou reconfigureraient un opencode : jamais, ni côté principal (P6) ni côté salle (stop-request seul). */
const RECHARGEMENTS = /^(PATCH \/global\/config|POST \/global\/dispose|POST \/instance\/dispose)$/;
const faitsDe = (a: Atelier, rootId: string): ActivityFact[] => a.h.cockpit.c11.ports.facts.since(rootId, 0).facts;

// --- 1. La chaîne complète d'une demande -------------------------------------------------------------------------------------------

describe("croisement V4 (2 ter) n° 1 : activation → un envoi → répondeur → plafond → arrêt → nouvelle confirmation", () => {
  it("un seul envoi ; « once » et refus d'un interdit ; plafond de coût → guard-state.json puis stopTreeOmo sans …/command ; relance ; second envoi refusé ; nouvelle confirmation", async (t: TestContext) => {
    const a = await atelier(t);
    await a.pret();
    const racine = await a.ouvrirSalle();
    const repereSalle = a.omo.fake.requests.length;
    const reperePrincipal = a.h.fake.requests.length;

    const activation = await a.activer(racine, "0,05");
    assert.equal(activation.status, 200, activation.body);
    assert.equal(activation.json<OmoAutonomyView>().instance, "omo");
    assert.equal(envois(a, repereSalle), 0, "une activation n'envoie rien");

    // Le tour de la salle : une commande permise, une commande qui lit un .env (interdit absolu), puis une reprise coûteuse.
    a.omo.fake.script(racine, { tools: [bash("npm test"), bash("cat .env")], cost: 0.01, followUp: { text: "[synthétique] fini", cost: 0.06 } });
    const envoi = await a.envoyer(racine);
    assert.equal(envoi.status, 204, JSON.stringify(envoi.body));
    await until(() => a.controle(OMO_FICHIERS_CONTROLE.arret), 8_000);
    await a.settled();

    // Un seul envoi, et jamais de commande ni de rechargement, d'aucun côté.
    assert.equal(envois(a, repereSalle), 1);
    assert.deepEqual(a.salle().filter((r) => r.endsWith("/command")), []);
    assert.deepEqual(a.salle().filter((r) => RECHARGEMENTS.test(r)), [], "la salle n'est relancée que par stop-request");
    // Répondeur (L22d) par le portillon de la salle : « once » pour la commande permise, refus avec sa phrase pour l'interdit.
    const reponses = a.reponses();
    assert.equal(reponses.length, 2, JSON.stringify(reponses));
    assert.deepEqual(
      reponses.map((r) => [r.reply, r.message]).sort(),
      [
        ["once", undefined],
        ["reject", messageInterdit("env")],
      ].sort(),
    );
    assert.ok(reponses.every((r) => a.omo.deps.gate.emitted.has(r.id)), "chaque réponse inscrite au registre de la salle");
    // Plafond (L22d) : filet du plugin de garde d'abord (L17b écrit guard-state.json), puis l'arrêt (L23b).
    assert.deepEqual(analyserGuardState(a.controle(OMO_FICHIERS_CONTROLE.garde))?.bloquer, ["task", "call_omo_agent"]);
    const arret = analyserArret(a.controle(OMO_FICHIERS_CONTROLE.arret));
    assert.deepEqual([arret?.cause, arret?.startId], ["plafond-cout", START_1]);
    assert.deepEqual(a.ligneDemarrage(START_1), { cause: "plafond-cout", fin: "arret-confirme" });
    assert.ok(
      faitsDe(a, racine).some((f) => f.kind === "statut" && f.data.cause === "plafond"),
      "fait statut du plafond",
    );
    // La demande est close par l'arrêt (L23b → L22c), le dernier montant écrit par l'envoi confirmé seulement.
    assert.equal(a.h.cockpit.c11.ports.omoActivation.activeRequest(), null);
    assert.equal(new ConversationAutonomyStore(a.h.db).readOmo(racine)?.demande, null);
    assert.equal(a.h.settings.get().budget.omo.dernierPlafondUsd, "0,05");
    // P6 : l'instance PRINCIPALE n'a rien reçu, rien n'a été rechargé ni redémarré.
    assert.deepEqual(a.h.fake.requests.slice(reperePrincipal).map((r) => `${r.method} ${r.pathname}`), []);
    a.h.assertNoGlobalRestart();

    // Second envoi sans nouvelle confirmation : refusé, rien n'est envoyé.
    refusEnvoi(await a.envoyer(racine), "jeton-consomme");
    assert.equal(envois(a, repereSalle), 1);
    // Nouvelle confirmation : la salle se relance à neuf (« arret » publié par le superviseur) → refusée tant que dure la relance.
    refusPut(await a.activer(racine, "0,08"), "salle-en-relance");
    await a.demarrer(START_2);
    const nouvelle = await a.activer(racine, "0,08");
    assert.equal(nouvelle.status, 200, nouvelle.body);
    a.omo.fake.script(racine, { text: "[synthétique] suite", cost: 0.001 });
    assert.equal((await a.envoyer(racine)).status, 204);
    assert.equal(envois(a, repereSalle), 2);
    assert.equal(a.h.settings.get().budget.omo.dernierPlafondUsd, "0,08");
  });
});

// --- 2. Réponse non émise → arrêt en 5 s au plus ----------------------------------------------------------------------------------

describe("croisement V4 (2 ter) n° 2 : réponse non émise par le cockpit → arrêt en 5 s au plus", () => {
  it("un programme muni du mot de passe de la salle répond « once » à l'interdit que le répondeur RETIENT → reponse-non-emise, arrêt hors-controle", async (t: TestContext) => {
    const a = await atelier(t);
    await a.pret();
    const racine = await a.ouvrirSalle();
    assert.equal((await a.activer(racine, "1,00")).status, 200);
    let libere: () => void = () => undefined;
    const voisin = new Promise<void>((resolve) => {
      libere = resolve;
    });
    t.after(() => libere());
    a.omo.fake.script(racine, {
      tools: [bash("cat .env", { callID: "call_interdit" }), bash("npm test", { callID: "call_voisin", beforeAsk: () => voisin })],
      followUp: { text: "[synthétique] fini" },
    });
    assert.equal((await a.envoyer(racine)).status, 204);
    const demande = await until(() => a.omo.fake.pendingPermissions().find((p) => p.patterns.includes("cat .env")), 5_000);
    // Pas de settled() du répondeur ici : il attend précisément ce refus retenu. Le processeur de la salle, puis un délai.
    await a.omo.deps.processor.settled();
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    // F-c : le refus est RETENU tant que l'appel voisin peut encore demander ; rien n'est parti.
    assert.deepEqual(a.reponses(), []);

    const debut = Date.now();
    // Le programme répond dans le dossier de la conversation, comme opencode l'exige (demandes rangées par dossier).
    await a.omo.deps.client.request("POST", `/permission/${demande.id}/reply`, { directory: a.omo.fake.session(racine)?.directory, body: { reply: "once" } });
    await until(() => a.controle(OMO_FICHIERS_CONTROLE.arret), OMO_DETECTIONS_BORNE_MS);
    assert.ok(Date.now() - debut < OMO_DETECTIONS_BORNE_MS, `${Date.now() - debut} ms`);
    libere();
    await a.settled();
    assert.equal(analyserArret(a.controle(OMO_FICHIERS_CONTROLE.arret))?.cause, "hors-controle");
    assert.deepEqual(
      a.evenements<OmoHorsControleData>("omo.hors-controle").map((e) => [e.rootId, e.cause]),
      [[racine, "reponse-non-emise"]],
    );
    assert.deepEqual(a.ligneDemarrage(START_1), { cause: "hors-controle", fin: "arret-confirme" });
    assert.equal(a.h.cockpit.c11.ports.omoActivation.activeRequest(), null);
    assert.deepEqual(a.salle().filter((r) => r.endsWith("/command")), []);
  });
});

// --- 3. Fin de demande → relance à neuf ---------------------------------------------------------------------------------------------

describe("croisement V4 (2 ter) n° 3 : fin de demande → relance à neuf", () => {
  it("15 s au repos (horloge des plafonds) → demande terminée, stop-request « fin-de-demande » du démarrage, boulder.json gardé ; aucune détection ; nouvelle demande après la relance", async (t: TestContext) => {
    const a = await atelier(t);
    await a.pret();
    const racine = await a.ouvrirSalle();
    // Un plan laissé sur le poste (A16 : la salle ne peut pas écrire dans .omo) : une fin de demande ne le met JAMAIS de côté.
    fs.mkdirSync(path.join(a.dirApp, ".omo"), { recursive: true });
    fs.writeFileSync(path.join(a.dirApp, ".omo", "boulder.json"), '{"[synthétique]": "plan"}', "utf8");
    assert.equal((await a.activer(racine, "1,00")).status, 200);
    a.omo.fake.script(racine, { text: "[synthétique] fini", cost: 0.001 });
    assert.equal((await a.envoyer(racine)).status, 204);
    await a.omo.fake.settled(racine);
    await until(() => a.omo.fake.statusOf(racine).type === "idle");
    // Repère émis APRÈS le repos : quand le processeur de la salle l'a vu, il a vu le repos avant lui.
    await a.h.emitOmo({ directory: a.dirApp, payload: { type: "harnais.repere", properties: {} } } as OcGlobalEvent);
    await a.settled();
    assert.equal(a.controle(OMO_FICHIERS_CONTROLE.arret), null, "rien avant les 15 s de repos");

    a.horlogeCaps.avancer(OMO_LIMITES.finDemandeReposS * 1000);
    await until(() => a.controle(OMO_FICHIERS_CONTROLE.arret), 5_000);
    await a.settled();
    assert.deepEqual(
      (({ cause, startId }) => [cause, startId])(analyserArret(a.controle(OMO_FICHIERS_CONTROLE.arret)) ?? { cause: null, startId: null }),
      ["fin-de-demande", START_1],
    );
    assert.deepEqual(a.ligneDemarrage(START_1)?.cause, "fin-de-demande");
    assert.ok(
      a.evenements<{ raison: string }>("omo.recreation").some((e) => e.raison === "fin-de-demande"),
      "omo.recreation « fin-de-demande »",
    );
    assert.equal(fs.readFileSync(path.join(a.dirApp, ".omo", "boulder.json"), "utf8"), '{"[synthétique]": "plan"}');
    assert.equal(a.h.cockpit.c11.ports.omoActivation.activeRequest(), null);
    assert.equal(new ConversationAutonomyStore(a.h.db).readOmo(racine)?.retourCause, null, "terminée, pas « interrompue »");
    // La relance demandée par le cockpit n'est pas lue comme une activité de l'extension.
    assert.deepEqual(a.evenements("omo.hors-controle"), []);
    assert.deepEqual(a.salle().filter((r) => r.endsWith("/command") || RECHARGEMENTS.test(r)), []);

    await a.demarrer(START_2);
    assert.equal((await a.activer(racine, "1,00")).status, 200);
  });
});

// --- 4. Redémarrage du cockpit pendant une délégation --------------------------------------------------------------------------------

describe("croisement V4 (2 ter) n° 4 : redémarrage du cockpit pendant une délégation", () => {
  it("stop-request « redemarrage-cockpit » du démarrage en cours, demande « interrompue », aucun appel qui écrive à la salle après la reprise, nouvelle confirmation exigée", async (t: TestContext) => {
    const a = await atelier(t);
    await a.pret();
    const racine = await a.ouvrirSalle();
    assert.equal((await a.activer(racine, "1,00")).status, 200);
    a.omo.fake.script(racine, {
      tools: [{ tool: "task", input: { description: "Analyser", prompt: "[synthétique] consigne", subagent_type: "general" }, child: { agent: "general", workMs: 60_000 } }],
    });
    assert.equal((await a.envoyer(racine)).status, 204);
    const enfant = ((await a.omo.fake.waitForEvent("session.created", (p) => (p.info as OcSession).parentID === racine)).properties.info as OcSession).id;
    await until(() => a.omo.fake.statusOf(enfant).type === "busy" && a.h.sessions.get(enfant));
    await a.settled();
    const reperePrincipal = a.h.fake.requests.length;

    // Les étapes de démarrage d'un cockpit relancé, dans l'ordre du câblage (STEP_ORDER.startup).
    await within(a.h.cockpit.startup(), "démarrage du cockpit", 10_000);
    await a.settled();
    const arret = analyserArret(a.controle(OMO_FICHIERS_CONTROLE.arret));
    assert.deepEqual([arret?.cause, arret?.startId], ["redemarrage-cockpit", START_1]);
    assert.deepEqual(a.ligneDemarrage(START_1), { cause: "redemarrage-cockpit", fin: "arret-confirme" });
    await within(Promise.all([a.omo.fake.settled(racine), a.omo.fake.settled(enfant)]), "salle au repos");
    // La demande est « interrompue » (L23b → L22c), et la vue de la page le dit.
    const vue = await a.h.call("GET", `/api/conversations/${racine}/autonomie`, { headers: a.h.headers.authed });
    assert.equal(vue.status, 200, vue.body);
    assert.deepEqual(
      (({ retourCause, demande }) => ({ retourCause, demande }))(vue.json<OmoAutonomyView>()),
      { retourCause: "interrompue", demande: null },
    );

    // Après la reprise : rien qui écrive à la salle (lectures du processeur seules), zéro …/command, rien à l'instance principale.
    const repere = a.omo.fake.requests.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(a.salle(repere).filter((r) => !r.startsWith("GET ")), []);
    assert.deepEqual(a.salle().filter((r) => r.endsWith("/command")), []);
    assert.deepEqual(a.h.fake.requests.slice(reperePrincipal).map((r) => `${r.method} ${r.pathname}`), []);
    a.h.assertNoGlobalRestart();
    refusEnvoi(await a.envoyer(racine), "jeton-consomme");
  });
});

// --- 5. Activité hors demande, suspension, réouverture ----------------------------------------------------------------------------

describe("croisement V4 (2 ter) n° 5 : activité hors demande → arrêt ; deux en 10 min → suspendue ; réouverture → levée", () => {
  it("deux activités sans demande → deux arrêts puis suspension ; la réouverture confirmée lève la suspension, fait pré-contrôler le démarrage en attente et la salle redémarre", async (t: TestContext) => {
    const a = await atelier(t);
    await a.pret();
    const racine = await a.ouvrirSalle();
    // « Programme » muni du mot de passe de la salle : un envoi direct, sans demande du cockpit.
    const programme = async (texte: string) => {
      a.omo.fake.script(racine, { text: texte, cost: 0.001 });
      await a.omo.deps.client.request("POST", `/session/${racine}/prompt_async`, { directory: a.dirApp, body: { model: MODEL, parts: [{ type: "text", text: texte }] } });
    };

    await programme("[synthétique] premier");
    await until(() => a.controle(OMO_FICHIERS_CONTROLE.arret), OMO_DETECTIONS_BORNE_MS);
    await a.settled();
    assert.deepEqual([analyserArret(a.controle(OMO_FICHIERS_CONTROLE.arret))?.cause, a.control().suspended()], ["hors-controle", false]);

    // La salle relancée à neuf : nouveau démarrage, nouvelles références ; seconde activité dans les 10 minutes.
    await a.demarrer(START_2);
    await programme("[synthétique] second");
    await until(() => analyserArret(a.controle(OMO_FICHIERS_CONTROLE.arret))?.startId === START_2, OMO_DETECTIONS_BORNE_MS);
    await a.settled();
    assert.equal(a.control().suspended(), true, "deux activités hors demande en 10 min : suspendue");
    assert.deepEqual(
      a.evenements<OmoHorsControleData>("omo.hors-controle").map((e) => e.cause),
      ["activite-hors-demande", "activite-hors-demande"],
    );

    // Le superviseur relance et ATTEND : la surveillance de L19b voit ce démarrage et le refuse (suspendue), aucun precheck-ok.
    a.publier(etatDe(START_3, "attente"));
    const refus = await a.h.cockpit.c11.ports.omoPrecheck.beforeStart(START_3);
    assert.deepEqual([refus.ok, refus.ok ? null : refus.code], [false, "salle-suspendue"]);
    refusPut(await a.activer(racine, "1,00"), "salle-suspendue");

    // Réouverture confirmée : suspension levée AVANT la création de la racine, démarrage en attente pré-contrôlé ; opencode n'est
    // pas encore lancé → 409 « salle-en-relance » (jamais un 500), et la suspension reste levée.
    const premiere = await a.ouvrir();
    assert.equal(premiere.status, 409, premiere.body);
    assert.equal(premiere.json<{ error: string }>().error, "salle-en-relance");
    assert.equal(a.control().suspended(), false, "levée par la réouverture confirmée");
    assert.equal(analyserPrecheckOk(a.controle(OMO_FICHIERS_CONTROLE.precheck))?.startId, START_3);
    // Le superviseur a maintenant battement ET precheck-ok de ce démarrage : il lance opencode, et la salle s'ouvre.
    a.lancer();
    const salle = await a.ouvrirSalle();
    assert.equal((await a.activer(salle, "1,00")).status, 200);
  });
});

// --- 6. .git créé → quarantaine -----------------------------------------------------------------------------------------------------

describe("croisement V4 (2 ter) n° 6 : .git créé pendant une demande → quarantaine puis arrêt", () => {
  it("un dépôt créé dans une entrée ouverte en écriture est renommé .git.suspect-… AVANT l'arrêt ; le .git protégé du projet n'est jamais touché", async (t: TestContext) => {
    const a = await atelier(t);
    await a.pret();
    const racine = await a.ouvrirSalle();
    assert.equal((await a.activer(racine, "1,00")).status, 200);
    const cree = path.join(a.dirApp, "src", ".git");
    a.omo.fake.script(racine, {
      tools: [
        bash("npm test", {
          beforeAsk: async () => {
            fs.mkdirSync(cree, { recursive: true });
            fs.writeFileSync(path.join(cree, "HEAD"), "ref: refs/heads/piege\n", "utf8");
          },
        }),
      ],
      followUp: { text: "[synthétique] fini" },
    });
    assert.equal((await a.envoyer(racine)).status, 204);
    await until(() => a.controle(OMO_FICHIERS_CONTROLE.arret), OMO_DETECTIONS_BORNE_MS);
    await a.settled();
    assert.equal(analyserArret(a.controle(OMO_FICHIERS_CONTROLE.arret))?.cause, "hors-controle");
    assert.equal(fs.existsSync(cree), false, "le .git créé n'est plus là");
    assert.equal(fs.readdirSync(path.join(a.dirApp, "src")).filter((nom) => /^\.git\.suspect-/.test(nom)).length, 1);
    assert.equal(fs.readFileSync(path.join(a.dirApp, ".git", "HEAD"), "utf8"), "ref: refs/heads/principale\n", ".git protégé intact");
    const detection = a.evenements<OmoHorsControleData>("omo.hors-controle");
    assert.equal(detection.length, 1);
    assert.ok(detection[0]?.signales.some((s) => s.genre === "git-quarantaine"), JSON.stringify(detection));
  });
});

// --- 7. Différé = direct, et l'extension vue par la scène ---------------------------------------------------------------------------

describe("croisement V4 (2 ter) n° 7 : « différé = direct » sur les faits des vrais services ; action de l'extension sans demande", () => {
  it("les faits écrits par la demande (L22c, L22d, L23c, L25a) : réducteur en direct = relecture depuis la base ; l'outil sans demande est une boucle orange comptée une fois, jamais un signe du cockpit", async (t: TestContext) => {
    const a = await atelier(t);
    await a.pret();
    const racine = await a.ouvrirSalle();
    assert.equal((await a.activer(racine, "1,00")).status, 200);
    const outil = OMO_OUTILS_SANS_DEMANDE[0];
    assert.ok(outil, "l'audit de L20 liste au moins un outil sans demande");
    a.omo.fake.script(racine, { tools: [{ tool: outil, callID: "call_extension_1", input: {}, output: "ok" }, bash("npm test")], followUp: { text: "[synthétique] fini" } });
    assert.equal((await a.envoyer(racine)).status, 204);
    await a.omo.fake.settled(racine);
    await a.settled();

    const base = faitsDe(a, racine);
    const extension = base.filter((f) => f.kind === "decision" && f.data.par === "extension");
    assert.deepEqual(
      extension.map((f) => f.ref),
      ["call_extension_1"],
      "L23c écrit la marque que L25b lit",
    );
    // Direct : les faits tels que la page les reçoit (activite.fait), dans l'ordre. Différé : relus depuis la base (JSON aller-retour).
    const recus = a.evenements<ActivityFact>("activite.fait").filter((f) => f.rootId === racine);
    assert.equal(recus.length, base.length);
    const vivant = recus.reduce((state, data) => applyEvent(state, { kind: "cockpit", type: "activite.fait", data }), emptyActivity(racine));
    const differe = replayFacts(emptyActivity(racine), JSON.parse(JSON.stringify(base)) as unknown[]);
    assert.deepEqual(liveRows(differe, 100_000), liveRows(vivant, 100_000));
    assert.deepEqual(timeline(differe), timeline(vivant));
    assert.deepEqual(totals(differe), totals(vivant));
    assert.deepEqual(activityStatus(differe), activityStatus(vivant));
    assert.equal(liveRows(vivant, 100_000).find((ligne) => ligne.key === racine)?.actionsExtension, 1);
    const options = { zoom: 2 as const, mode: "avance" as const, roleSalle: roleDeAgent };
    const vueDirecte = scene(recus, null, options);
    assert.deepEqual(scene(base, null, options), vueDirecte, "scène : différé = direct");
    assert.deepEqual(
      vueDirecte.extensions.map((e) => [e.sessionId, e.actions]),
      [[racine, 1]],
    );
    assert.notEqual(vueDirecte.enceinte, null, "l'enceinte de la salle est dessinée");
    // Le « once » du répondeur, lui, reste une décision du cockpit ; l'action de l'extension n'en est pas une.
    assert.ok(
      base.filter((f) => f.kind === "decision" && f.data.par !== "extension").every((f) => f.data.verdict === "auto"),
      JSON.stringify(base.filter((f) => f.kind === "decision")),
    );
    assert.equal(scene(recus, null, { ...options, mode: "simple" }).extensions.length, 0, "rien en mode Simple");
  });
});

// --- 9. Arrêt non confirmé : battement coupé, repris par la réouverture -------------------------------------------------------------

describe("croisement V4 (2 ter) n° 9 : arrêt non confirmé → battement coupé ; la réouverture confirmée le reprend", () => {
  it("« Arrêter » sans réponse du superviseur → arrêt non confirmé, battement retiré (L23b) : le démarrage suivant ne peut pas être lancé ; la réouverture reprend le battement et la salle redémarre", async (t: TestContext) => {
    const a = await atelier(t);
    await a.pret();
    const racine = await a.ouvrirSalle();
    a.superviseurMuet(true);
    const arret = await a.h.call("POST", `/api/omo/rooms/${racine}/stop`, { headers: a.h.headers.mutating });
    assert.equal(arret.status, 200, arret.body);
    await a.settled();
    assert.deepEqual(a.ligneDemarrage(START_1), { cause: "vous", fin: "arret-non-confirme" });
    assert.equal(a.controle(OMO_FICHIERS_CONTROLE.battement), null, "battement retiré : l'homme mort arrête la salle");

    // L'homme mort a fait son œuvre : relance à neuf, nouveau démarrage pré-contrôlé… mais sans battement, rien n'est lancé.
    a.superviseurMuet(false);
    a.publier(etatDe(START_2, "attente"));
    const issue = await a.h.cockpit.c11.ports.omoPrecheck.beforeStart(START_2);
    assert.equal(issue.ok, true, JSON.stringify(issue));
    assert.throws(() => a.lancer(), /aucun battement frais du cockpit/);

    // Réouverture confirmée : le battement reprend (correction du train) ; opencode pas encore lancé → 409 « salle-en-relance ».
    const premiere = await a.ouvrir();
    assert.equal(premiere.status, 409, premiere.body);
    assert.equal(premiere.json<{ error: string }>().error, "salle-en-relance");
    await until(() => a.controle(OMO_FICHIERS_CONTROLE.battement), 5_000);
    a.lancer();
    const salle = await a.ouvrirSalle();
    assert.equal((await a.activer(salle, "1,00")).status, 200);
  });
});

// --- 10. La page de la salle envoie avec l'IA de l'assistant ----------------------------------------------------------------------

/**
 * Fetch du NAVIGATEUR remplacé : chaque appel relatif (« /api/… », ceux de la page) est noté et reçoit la réponse de `repondre`
 * (proxy réel, ou réponse écrite). Les appels absolus sont ceux du SERVEUR vers les faux opencode : ils passent au vrai fetch.
 */
function fetchEspion(t: TestContext, repondre: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const appels: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
  const vraiFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("/")) return vraiFetch(input, init);
    appels.push({ method: init.method ?? "GET", url, body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null });
    return repondre(url, init);
  });
  return appels;
}
const reponse = (status: number, corps?: unknown) => new Response(corps === undefined ? null : JSON.stringify(corps), { status });
const AGENTS_SALLE = [
  { name: "sisyphus-junior", mode: "subagent", model: { providerID: "github-copilot", modelID: "gpt-5" }, options: {}, permission: [] },
  { name: "build", mode: "primary", model: MODEL, options: {}, permission: [] },
  { name: "plan", mode: "primary", model: { providerID: "github-copilot", modelID: "gpt-5" }, options: {}, permission: [] },
];

describe("croisement V4 (2 ter) n° 10 : la page de la salle envoie avec l'IA de l'assistant (constat n° 2 de L21b)", () => {
  it("par le proxy RÉEL de la salle : `{ parts }` seul → 400 « modele-requis » sans rien envoyer (le défaut) ; envoyerMessageOmo → 204, un seul envoi, l'IA de l'assistant « build » dans le corps relayé", async (t: TestContext) => {
    const a = await atelier(t);
    await a.pret();
    a.omo.fake.setAgents(AGENTS_SALLE as Parameters<typeof a.omo.fake.setAgents>[0]);
    const racine = await a.ouvrirSalle();
    const repere = a.omo.fake.requests.length;
    assert.equal((await a.activer(racine, "1,00")).status, 200);
    a.omo.fake.script(racine, { text: "[synthétique] fini", cost: 0.001 });
    // Dossier tel qu'opencode le voit (celui que la page relit dans la session de la salle).
    const dossier = a.h.deps.projects.toOpencodePath(a.dirApp);
    const appels = fetchEspion(t, (url, init) => {
      assert.ok(url.startsWith("/api/omo/oc/"), `la page n'appelle que la salle : ${url}`);
      return a.proxy.request(url, init);
    });
    // Ce que la page envoyait avant le train : refusé avant les crochets, le jeton reste entier.
    await assert.rejects(envoyerOmo(racine, dossier, { parts: [{ type: "text", text: "[synthétique] travaille" }] }), (err: unknown) => err instanceof ApiError && err.code === "modele-requis");
    assert.equal(envois(a, repere), 0);
    appels.length = 0;
    await envoyerMessageOmo(racine, dossier, "[synthétique] travaille");
    assert.deepEqual(
      appels.map((appel) => `${appel.method} ${appel.url.split("?")[0]}`),
      ["GET /api/omo/oc/agent", `POST /api/omo/oc/session/${racine}/prompt_async`],
    );
    assert.equal(envois(a, repere), 1);
    const relaye = a.omo.fake.requests.slice(repere).find((r) => r.method === "POST" && r.pathname.endsWith("/prompt_async"));
    assert.deepEqual((relaye?.body as { model?: unknown }).model, MODEL);
    // Le jeton est consommé par CET envoi : un second message exige une nouvelle confirmation.
    await assert.rejects(envoyerMessageOmo(racine, dossier, "[synthétique] encore"), (err: unknown) => err instanceof ApiError && err.status === 409);
    assert.equal(envois(a, repere), 1);
  });

  it("409 « assistant-model-changed » : UN seul renvoi avec l'IA et la réflexion reçues ; un second 409 est rendu, jamais un troisième envoi", async (t: TestContext) => {
    const change = { error: "assistant-model-changed", message: "IA changée.", agent: "build", model: { providerID: "github-copilot", modelID: "claude-sonnet-5" }, variant: "high", modelName: "Claude Sonnet 5" };
    const reponses = [reponse(200, AGENTS_SALLE), reponse(409, change), reponse(204)];
    const appels = fetchEspion(t, () => reponses.shift() ?? reponse(500));
    await envoyerMessageOmo("ses_salle1", "/workspace/app", "[synthétique] travaille");
    assert.equal(appels.length, 3);
    assert.equal(appels[0]?.url, "/api/omo/oc/agent?directory=%2Fworkspace%2Fapp");
    assert.deepEqual(appels[1]?.body, { parts: [{ type: "text", text: "[synthétique] travaille" }], model: MODEL });
    assert.deepEqual(appels[2]?.body, { parts: [{ type: "text", text: "[synthétique] travaille" }], model: change.model, variant: "high" });

    const encore = [reponse(200, AGENTS_SALLE), reponse(409, change), reponse(409, change)];
    const seconds = fetchEspion(t, () => encore.shift() ?? reponse(500));
    await assert.rejects(envoyerMessageOmo("ses_salle1", "/workspace/app", "[synthétique] travaille"), (err: unknown) => err instanceof ApiError && err.code === "assistant-model-changed");
    assert.equal(seconds.length, 3);
  });

  it("aucune IA lisible chez les assistants de la salle : rien n'est inventé, le corps part sans IA et le refus du serveur est rendu", async (t: TestContext) => {
    assert.equal(modeleEnvoiSalle([{ name: "build", mode: "subagent", model: MODEL }]), null, "un sous-agent n'est jamais l'assistant d'un envoi");
    assert.equal(modeleEnvoiSalle([{ name: "build", mode: "primary" }]), null);
    assert.equal(modeleEnvoiSalle({ agents: [] }), null);
    assert.deepEqual(modeleEnvoiSalle([{ name: "cache", mode: "primary", hidden: true, model: { providerID: "x", modelID: "y" } }, { name: "plan", mode: "primary", model: MODEL }]), MODEL);
    const reponses = [reponse(200, [{ name: "build", mode: "primary" }]), reponse(400, { error: "modele-requis", message: "Précisez l'IA de la demande." })];
    const appels = fetchEspion(t, () => reponses.shift() ?? reponse(500));
    await assert.rejects(envoyerMessageOmo("ses_salle1", "/workspace/app", "[synthétique] travaille"), (err: unknown) => err instanceof ApiError && err.code === "modele-requis");
    assert.deepEqual(appels[1]?.body, { parts: [{ type: "text", text: "[synthétique] travaille" }] });
  });

  it("la page de la salle envoie par envoyerMessageOmo, jamais un corps `{ parts }` seul", () => {
    const page = fs.readFileSync(path.join(import.meta.dirname, "..", "web", "pages", "omo", "SalleOmoPage.tsx"), "utf8");
    assert.match(page, /\.then\(\(\) => envoyerMessageOmo\(salle\.rootId, salle\.directory, texte\)\)/);
    assert.equal(/envoyerOmo\(/.test(page), false);
  });
});

// --- 11. L'écran Budget et le dernier montant de la salle ---------------------------------------------------------------------------

describe("croisement V4 (2 ter) n° 11 : l'écran Budget n'envoie jamais budget.omo (remarque n° 6 de L22c)", () => {
  it("brouillon ouvert AVANT une activation : renvoyé entier → 403 « reglage-fixe » ; tel que l'écran l'envoie (sans omo) → 200, dernier montant gardé", async (t: TestContext) => {
    const a = await atelier(t);
    await a.pret();
    const racine = await a.ouvrirSalle();
    // Brouillon de l'écran Budget, pris avant l'activation (dernier montant encore vide), puis modifié par l'utilisateur.
    const brouillon = { ...structuredClone(a.h.settings.get().budget), monthlyUsd: 42 };
    assert.equal(brouillon.omo.dernierPlafondUsd, null);
    assert.equal((await a.activer(racine, "1,25")).status, 200);
    a.omo.fake.script(racine, { text: "[synthétique] fini", cost: 0.001 });
    assert.equal((await a.envoyer(racine)).status, 204);
    assert.equal(a.h.settings.get().budget.omo.dernierPlafondUsd, "1,25");

    const entier = await a.h.call("PUT", "/api/settings", { headers: a.h.headers.mutating, body: { budget: brouillon } });
    assert.equal(entier.status, 403, entier.body);
    assert.equal(entier.json<{ error: string }>().error, "reglage-fixe");
    // Le corps que l'écran construit (même expression que BudgetTab.tsx, vérifiée ci-dessous).
    const corps = { budget: Object.fromEntries(Object.entries(brouillon).filter(([cle]) => cle !== "omo")) };
    const ecran = await a.h.call("PUT", "/api/settings", { headers: a.h.headers.mutating, body: corps });
    assert.equal(ecran.status, 200, ecran.body);
    assert.equal(a.h.settings.get().budget.monthlyUsd, 42);
    assert.equal(a.h.settings.get().budget.omo.dernierPlafondUsd, "1,25", "dernier montant gardé");

    const source = fs.readFileSync(path.join(import.meta.dirname, "..", "web", "pages", "settings", "BudgetTab.tsx"), "utf8");
    assert.match(source, /save\(\{ budget: Object\.fromEntries\(Object\.entries\(draft\)\.filter\(\(\[cle\]\) => cle !== "omo"\)\) \}, "Budget enregistré"/);
    assert.equal(/save\(\{ budget: draft \}/.test(source), false);
  });
});

// --- 8. Le dépôt tel qu'il est livré ------------------------------------------------------------------------------------------------

describe("croisement V4 (2 ter) n° 8 : dépôt livré, salle coupée — aucun service de la vague, aucun battement", () => {
  it("modules « tous », option omo, démarrage lancé : ports de la vague neutres, aucun fichier dans les volumes de la salle, SALLE_OUVERTE fausse", async (t: TestContext) => {
    assert.equal(SALLE_OUVERTE, false);
    const h = await startCockpit(t, { omo: true, modules: "tous", settings: { ui: { mode: "avance" } } });
    await within(h.cockpit.startup(), "démarrage du cockpit", 10_000);
    const ports = h.cockpit.c11.ports;
    await assert.rejects(ports.omoStop.run(null, "vous"), PortUnavailableError);
    assert.equal(ports.omoActivation.activeRequest(), null);
    assert.deepEqual(await ports.omoActivation.consume("ses_inconnue"), { ok: false, code: "salle-coupee" });
    assert.deepEqual(ports.omoCaps, {});
    assert.deepEqual(ports.omoResponder, {});
    assert.deepEqual(ports.omoDetections, {});
    // L'étape de démarrage d'omoControl appelle désormais startHeartbeat : salle coupée, le service ne bat pas.
    await (ports.omoControl as OmoControlService).settled?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(h.omo?.fichiers(), []);
    h.assertNoGlobalRestart();
  });
});
