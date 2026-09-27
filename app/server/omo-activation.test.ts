// Activation « Comme Oh My OpenAgent » (L22c ; spécification §4.14.2 l.813-823, §4.8.2 l.729-730, §3.6 l.280-289, §4.11 l.774,
// §3.15.1 l.475, §7.6 l.1155 ; décisions n° 9, 10, 13 ; D-2b-07, D-2b-08, D-2b-11 ; décision A16) : PUT …/autonomie
// `{choix: "omo", plafondUsd}` confirmé à CHAQUE demande, jeton à usage unique pris par le crochet d'envoi de la salle,
// conditions revérifiées À L'ENVOI, 409 et phrase SANS AUCUN envoi, `dernierPlafondUsd` écrit par une activation confirmée
// seulement, demande « interrompue » au redémarrage du cockpit.
//
// Montage : cockpit réel du harnais avec l'option `omo` (second faux opencode = la salle, second processeur réel), module
// `conversationAutonomy` réel (routes GET/PUT …/autonomie, étape de démarrage), et proxy de la salle monté sur createOcProxy avec
// les crochets RÉELS du câblage (comme oc-proxy-omo.test.ts : le montage de createApp reste fermé tant que SALLE_OUVERTE est
// faux). Le service d'activation est le VRAI (`createOmoActivation`), installé par un module factice au nom réel sur un monde
// que chaque test peut casser : porte de la salle, interrupteur d'autonomie, battement (fichier du volume de contrôle),
// state.json (port `omoControl`), pré-contrôle (port `omoPrecheck`), `precheck-ok`, dossier de travail et omo-projets.json,
// catalogue du compte, garde-fou budgétaire. L'espion est le faux de la salle : « rien n'est envoyé » = aucun `prompt_async`.
//
// Chaque garde a son test qui échoue sans elle ; les mutations du paquet sont rejouées hors dépôt (mesures/mutations-L22c.mjs).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { Hono } from "hono";
import type { CatalogModel, CatalogSources } from "./catalog.ts";
import { type Cockpit11, type Cockpit11Module, type FactsPort, PortUnavailableError } from "./contracts-11.ts";
import { ConversationAutonomyStore, interruptSalleAtStartup } from "./conversation-autonomy.ts";
import type { AppEnv } from "./env.ts";
import { forbiddenCommandArguments, forbiddenProxyBody } from "./http.ts";
import type { Ledger } from "./ledger.ts";
import type { Logger } from "./log.ts";
import { createOcProxy, PROXY_RULES_OMO } from "./oc-proxy.ts";
import {
  createOmoActivation,
  installOmoActivation,
  neutralOmoActivation,
  OMO_IMAGE_ID_PREFIXE,
  OMO_JETON_DUREE_MS,
  type OmoActivationDeps,
  type OmoActivationService,
} from "./omo-activation.ts";
import type { OmoControlPort, OmoPrecheckOutcome, OmoPrecheckPort, OmoStopPort } from "./omo-contracts.ts";
import type { OcSession } from "./opencode.ts";
import { DEFAULT_SETTINGS, SettingsStore } from "./settings.ts";
import type { ActivityFact } from "./shared/activity-types.ts";
import type { OmoAutonomyView } from "./shared/api-types.ts";
import { ecrireArret, ecrireBattement, ecrirePrecheckOk, OMO_DELAIS, OMO_FICHIERS_CONTROLE } from "./shared/omo-control-protocol.ts";
import { OMO_LIMITES } from "./shared/omo-limits.ts";
import type { PrecheckBornes } from "./shared/omo-precheck-rules.ts";
import { phraseAdresseAImposer, TEXTES } from "./shared/omo-room-texts.ts";
import type { OmoActivationRefusalCode, OmoPreparedProjects, OmoSupervisorState } from "./shared/omo-types.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";

const START_ID = "0f5a2c1e-7b3d-4e8f-9a6b-1c2d3e4f5a6b";
const AUTRE_START_ID = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";
const SHA = "a".repeat(64);
const ENDPOINT_PAR_DEFAUT = "https://api.githubcopilot.com";

// --- Monde de la salle, modifiable par chaque test ---------------------------------------------------------------------------

interface Monde {
  salleOuverte: boolean;
  instance: boolean;
  autonomie: boolean;
  suspendue: boolean;
  image: string;
  etat: OmoSupervisorState | null;
  precheck: (projet: string) => OmoPrecheckOutcome;
  catalogue: { loaded: boolean; copilotVerified: boolean; endpoint: string | null; copilot: boolean; leve: boolean };
  /** Pourcentage du budget mensuel consommé, et décision du garde-fou pour un modèle. */
  budget: { pourcent: number; modeleAutorise: boolean };
  /** Fichier omo-projets.json : null = absent. */
  projetsFichier: string | null;
  bornes: Partial<PrecheckBornes> | undefined;
  /** Décalage de l'horloge du service (expiration du jeton). */
  decalageMs: number;
  /** Arrêt ou relance à neuf en cours côté cockpit (`omoStop.enCours`, relecture 2ter-vague-4). */
  arretEnCours: boolean;
}

interface Salle {
  h: CockpitHarness;
  monde: Monde;
  workspace: string;
  control: string;
  /** Service d'activation en vigueur (remplacé par `redemarrer`). */
  service(): OmoActivationService;
  /** Simule un redémarrage du cockpit : nouveau service (jetons et demande en mémoire perdus), puis l'étape de démarrage. */
  redemarrer(): Promise<void>;
  /** Appels du port d'activation par les routes (PUT). */
  appelsPut(): number;
  facts: ActivityFact[];
  journal: Array<[string, Record<string, unknown> | undefined]>;
  app: Hono;
  racine: string;
  /** Remet le monde dans l'état nominal (toutes les conditions remplies). */
  reparer(): void;
}

const projetsDe = (...chemins: string[]): OmoPreparedProjects => ({
  version: 1,
  genereLe: "2026-09-19T10:00:00Z",
  projets: chemins.map((chemin) => ({ chemin, git: "dossier" as const })),
  gitProteges: chemins.map((chemin) => ({ chemin: `${chemin}/.git`, forme: "dossier" as const })),
});

function etatPret(projets: readonly string[]): OmoSupervisorState {
  return {
    startId: START_ID,
    phase: "opencode-lance",
    imageId: `${OMO_IMAGE_ID_PREFIXE}base=sha256:${SHA} lock=sha256:${SHA}`,
    manifestSha256: SHA,
    manifesteReference: "ok",
    validation: "ok",
    dossiersConfig: [
      { chemin: "/home/node/.config/opencode", ok: true },
      { chemin: "/home/node/.omo", ok: true },
    ],
    projets: projets.map((chemin) => ({ chemin, gitLectureSeule: true })),
    workspaceGit: { verifieLe: Date.now(), limiteAtteinte: false, nonProteges: [] },
    startedAt: Date.now() - 1_000,
  };
}

function spyFacts(): FactsPort & { appended: ActivityFact[] } {
  const appended: ActivityFact[] = [];
  return {
    appended,
    append: (facts) => void appended.push(...facts),
    since: () => ({ facts: [], partial: false }),
    work: { markDelegation: () => false, markWait: () => false },
  };
}

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

const PROJETS = ["app", "autre"] as const;

/**
 * Cockpit réel, salle branchée sur le VRAI service d'activation, monde nominal : salle ouverte, battement frais, state.json vert
 * (sonde étendue de L16c : racine en lecture seule, aucun montage refusé), `precheck-ok` de ce démarrage, projets préparés et
 * protégés, catalogue Copilot vérifié à l'adresse d'office, budget libre. Une salle ouverte sur « app ».
 */
async function salle(t: TestContext, options: { mode?: "simple" | "avance"; env?: Partial<AppEnv> } = {}): Promise<Salle> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omo-activation-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dossier = (nom: string) => {
    const complet = path.join(tmp, nom);
    fs.mkdirSync(complet, { recursive: true });
    return complet;
  };
  const workspace = dossier("workspace");
  const control = dossier("control");
  const source = dossier("source");
  const projetsFichier = path.join(source, "omo-projets.json");
  fs.writeFileSync(projetsFichier, `${JSON.stringify(projetsDe(...PROJETS))}\n`, "utf8");
  for (const projet of PROJETS) fs.mkdirSync(path.join(workspace, projet, ".git"), { recursive: true });

  const nominal = (): Monde => ({
    salleOuverte: true,
    instance: true,
    autonomie: true,
    suspendue: false,
    image: "opencode-cockpit/opencode-omo:test",
    etat: etatPret(PROJETS),
    precheck: (projet) => ({ ok: true, resultat: { projet, verdict: "conforme", raison: null, trouves: [] } }),
    catalogue: { loaded: true, copilotVerified: true, endpoint: ENDPOINT_PAR_DEFAUT, copilot: true, leve: false },
    budget: { pourcent: 0, modeleAutorise: true },
    projetsFichier,
    bornes: undefined,
    decalageMs: 0,
    arretEnCours: false,
  });
  const monde = nominal();
  const ecrireControle = () => {
    fs.writeFileSync(path.join(control, OMO_FICHIERS_CONTROLE.battement), ecrireBattement(Date.now()), "utf8");
    fs.writeFileSync(
      path.join(control, OMO_FICHIERS_CONTROLE.precheck),
      ecrirePrecheckOk(
        START_ID,
        Date.now(),
        PROJETS.map((chemin) => ({ chemin, sha256: SHA })),
      ),
      "utf8",
    );
  };
  ecrireControle();

  const omoControl: OmoControlPort = {
    startHeartbeat: () => undefined,
    stopHeartbeat: () => undefined,
    requestStop: async () => undefined,
    writePrecheckOk: async () => undefined,
    writeGuardState: async () => undefined,
    publishAuth: async () => undefined,
    readState: async () => (monde.etat === null ? null : structuredClone(monde.etat)),
    suspend: () => undefined,
    resume: () => undefined,
    suspended: () => monde.suspendue,
  };
  const omoPrecheck: OmoPrecheckPort = {
    check: async (projet) => monde.precheck(projet),
    beforeStart: async (startId) => ({ ok: true, startId, resultats: [] }),
  };
  // Arrêt de la salle : seul `enCours` est lu par l'activation (relecture 2ter-vague-4) ; aucun arrêt n'est lancé par ces tests.
  const omoStop: OmoStopPort = {
    run: () => Promise.reject(new PortUnavailableError("omoStop")),
    relaunchAfterRequest: async () => undefined,
    enCours: () => monde.arretEnCours,
  };
  const facts = spyFacts();
  const journal: Salle["journal"] = [];
  const log: Logger = {
    debug: (message, fields) => void journal.push([message, fields]),
    info: (message, fields) => void journal.push([message, fields]),
    warn: (message, fields) => void journal.push([message, fields]),
    error: (message, fields) => void journal.push([message, fields]),
  };

  let c11Pose: Cockpit11 | null = null;
  let courant: OmoActivationService | null = null;
  let appelsPut = 0;
  const creerService = (c11: Cockpit11): OmoActivationService => {
    const ledger: Pick<Ledger, "percentUsed" | "guard"> = {
      percentUsed: () => monde.budget.pourcent,
      guard: () => (monde.budget.modeleAutorise ? { allowed: true, percent: 0, outputPricePerM: null } : { allowed: false, code: "expensive-model", message: "refus", percent: 90, outputPricePerM: 60 }),
    };
    const deps: OmoActivationDeps = {
      db: c11.db,
      sessions: c11.sessions,
      settings: c11.settings,
      ledger,
      log,
      env: {
        get autonomy() {
          return monde.autonomie;
        },
        copilotApiUrl: c11.env.copilotApiUrl,
        githubEnterpriseDomain: c11.env.githubEnterpriseDomain,
      },
      get image() {
        return monde.image;
      },
      workspace,
      controlDir: control,
      get projectsFile() {
        return monde.projetsFichier;
      },
      ports: () => c11.ports,
      instance: () => (monde.instance ? (c11.instances?.omo ?? null) : null),
      catalogue: () => {
        if (monde.catalogue.leve) throw new Error("catalogue illisible");
        const sources: CatalogSources = {
          opencodeError: null,
          copilotVerified: monde.catalogue.copilotVerified,
          copilotError: null,
          endpoint: monde.catalogue.endpoint === null ? null : { url: monde.catalogue.endpoint, source: "github", plan: null, opencodeDefault: ENDPOINT_PAR_DEFAUT },
          unavailable: [],
        };
        return { loaded: monde.catalogue.loaded, sources, list: () => (monde.catalogue.copilot ? [modeleCopilot()] : []) };
      },
      salleOuverte: () => monde.salleOuverte,
      now: () => Date.now() + monde.decalageMs,
      get bornes() {
        return monde.bornes;
      },
    };
    return createOmoActivation(deps);
  };
  const poser = (c11: Cockpit11) => {
    const service = creerService(c11);
    courant = service;
    // Espion sur le port : les routes n'appellent `put` que pour une racine de la salle.
    c11.ports.omoActivation = {
      ...service,
      put: (...args) => {
        appelsPut++;
        return service.put(...args);
      },
    };
  };
  const moduleActivation: Cockpit11Module = {
    name: "omoActivation",
    install(reg, c11) {
      c11Pose = c11;
      poser(c11);
      // Même inscription que installOmoActivation, relayée au service en vigueur (redémarrage simulé).
      reg.hook("beforeBilledSend", (ctx) => (courant as OmoActivationService).hook(ctx), { instances: ["omo"] });
    },
  };

  const h = await startCockpit(t, {
    omo: true,
    modules: ["conversationAutonomy", moduleActivation],
    ports: { omoControl, omoPrecheck, omoStop, facts },
    settings: { ui: { mode: options.mode ?? "avance" } },
    env: { workspaceDir: workspace, ...options.env },
  });
  assert.ok(h.omo, "harnais : option « omo »");

  const app = new Hono();
  app.all(
    "/api/omo/oc/*",
    createOcProxy({
      env: h.deps.env,
      log,
      projects: h.deps.projects,
      hooks: h.cockpit.wiring,
      instanceOf: (id: string) => h.sessions.get(id)?.instance ?? null,
      forbiddenProxyBody,
      forbiddenCommandArguments,
      enforceTurn: async (_c: unknown, _sub: string, _directory: string | null, body: string) => body,
      instance: h.omo.deps,
      prefix: "/api/omo/oc",
      rules: PROXY_RULES_OMO,
    }),
  );

  const s: Salle = {
    h,
    monde,
    workspace,
    control,
    service: () => courant as OmoActivationService,
    redemarrer: async () => {
      poser(c11Pose as Cockpit11);
      await h.cockpit.startup();
    },
    appelsPut: () => appelsPut,
    facts: facts.appended,
    journal,
    app,
    racine: "",
    reparer: () => {
      Object.assign(monde, nominal());
      ecrireControle();
      fs.rmSync(path.join(workspace, "app", "vendored"), { recursive: true, force: true });
      fs.rmSync(path.join(control, OMO_FICHIERS_CONTROLE.arret), { force: true });
      fs.writeFileSync(projetsFichier, `${JSON.stringify(projetsDe(...PROJETS))}\n`, "utf8");
    },
  };
  s.racine = await ouvrirSalle(s, "app");
  return s;
}

/** Racine créée sur le faux de la SALLE, suivie avec `instance = omo` et inscrite dans omo_rooms (comme POST /api/omo/rooms). */
async function ouvrirSalle(s: Pick<Salle, "h">, projet: string | null, parentID?: string): Promise<string> {
  const omo = s.h.omo;
  assert.ok(omo);
  const creee = await omo.deps.client.request<OcSession>("POST", "/session", {
    query: { directory: omo.fake.directory },
    body: { title: projet ?? "Salle", ...(parentID === undefined ? {} : { parentID }) },
  });
  s.h.sessions.upsert({ ...creee, directory: omo.fake.directory } as OcSession, undefined, { instance: "omo" });
  if (projet !== null && parentID === undefined) s.h.db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, ?, ?)").run(creee.id, projet, Date.now());
  return creee.id;
}

const url = (rootId: string) => `/api/conversations/${rootId}/autonomie`;

/** PUT …/autonomie, confirmé par défaut (x-cockpit-confirm: 1 et anti-CSRF). */
const activer = (s: Salle, body: unknown, rootId = s.racine, entetes: Record<string, string> = s.h.headers.confirmed) => s.h.call("PUT", url(rootId), { headers: entetes, body });

const corpsPrompt = () => ({ parts: [{ type: "text", text: "Bonjour" }], model: { providerID: "github-copilot", modelID: "gpt-5-mini" } });

/** Envoi d'une demande dans la salle, par le proxy de la salle (crochets réels du câblage). */
async function envoyer(s: Salle, rootId = s.racine): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await s.app.request(`/api/omo/oc/session/${rootId}/prompt_async`, {
    method: "POST",
    body: JSON.stringify(corpsPrompt()),
    headers: { "content-type": "application/json" },
  });
  const texte = await res.text();
  return { status: res.status, body: texte === "" ? null : (JSON.parse(texte) as Record<string, unknown>) };
}

/** Envois reçus par le faux de la SALLE (l'espion) : « rien n'est envoyé » = aucun prompt_async. */
const envoisRecus = (s: Salle) => (s.h.omo?.fake.requests ?? []).filter((r) => r.method === "POST" && r.pathname.endsWith("/prompt_async")).length;

/** Phrase attendue d'un refus : celle de T3a, gabarits remplis ({projet}, {liste}, {plafondMaxUsd}). */
function phrase(code: OmoActivationRefusalCode, valeurs: { projet?: string; liste?: readonly string[] } = {}): string {
  const gabarit = code === "mode-avance" ? TEXTES.partout.refus[code] : TEXTES.avance.refus[code];
  return gabarit
    .replace("{projet}", valeurs.projet ?? "app")
    .replace("{liste}", (valeurs.liste ?? []).join(", "))
    .replace("{plafondMaxUsd}", "5,00")
    .trim();
}

// `suite` (grande fusion, D5) : phrase qui suit celle du code, séparée par un point (celle d'« adresse-copilot-changee » n'en a pas).
const refusAttendu = (code: OmoActivationRefusalCode, liste: readonly string[] = [], suite?: string) => ({
  error: code === "mode-avance" ? "mode-avance" : "autonomie-indisponible",
  message: suite === undefined ? phrase(code, { liste }) : `${phrase(code, { liste })}. ${suite}`,
  raison: code,
  ...(liste.length > 0 ? { liste: [...liste] } : {}),
});

const dernierPlafond = (s: Salle) => s.h.settings.get().budget.omo.dernierPlafondUsd;

const vueSalle = async (s: Salle, rootId = s.racine) => {
  const res = await s.h.call("GET", url(rootId), { headers: s.h.headers.authed });
  assert.equal(res.status, 200, res.body);
  return res.json<OmoAutonomyView>();
};

/** Ligne « omo » de conversation_autonomy (montant confirmé, demande en cours). */
const ligneOmo = (s: Salle, rootId = s.racine) => new ConversationAutonomyStore(s.h.db).readOmo(rootId);

// --- Chemin nominal ---------------------------------------------------------------------------------------------------------

describe("L22c : activation confirmée, puis UN envoi", () => {
  it("PUT confirmé en Avancé → 200 ; l'envoi part une fois ; demande active ; dernierPlafondUsd écrit par l'envoi confirmé seulement", async (t) => {
    const s = await salle(t);
    const premiere = await vueSalle(s);
    // Première activation : champ vide (aucune valeur par défaut, Q7), constantes serveur affichées, « omo » seul disponible.
    assert.equal(premiere.instance, "omo");
    assert.equal(premiere.choix, "omo");
    assert.deepEqual(premiere.disponibles, [{ choix: "omo", disponible: true, raison: null }]);
    assert.equal(premiere.activation?.dernierPlafondUsd, null);
    assert.equal(premiere.activation?.horsBornes, false);
    assert.equal(premiere.activation?.plafondMaxUsd, 5);
    assert.deepEqual(premiere.limites, OMO_LIMITES);
    assert.equal(premiere.demande, null);
    assert.ok(premiere.activation?.conditions.every((c) => c.ok), JSON.stringify(premiere.activation?.conditions));

    const put = await activer(s, { choix: "omo", plafondUsd: "2,50" });
    assert.equal(put.status, 200, put.body);
    assert.equal(put.json<OmoAutonomyView>().choix, "omo");
    assert.equal(dernierPlafond(s), null, "une confirmation sans envoi n'écrit rien");
    assert.equal(envoisRecus(s), 0, "le PUT ne lance rien");

    const envoi = await envoyer(s);
    assert.equal(envoi.status, 204, JSON.stringify(envoi.body));
    assert.equal(envoisRecus(s), 1);
    const active = s.service().activeRequest();
    assert.equal(active?.rootId, s.racine);
    assert.equal(active?.plafondUsd, "2,50", "montant tel que saisi, jamais arrondi ni converti");
    assert.equal(dernierPlafond(s), "2,50");
    assert.deepEqual([ligneOmo(s)?.plafondUsd, ligneOmo(s)?.demande?.id], ["2,50", active?.requestId]);

    const apres = await vueSalle(s);
    assert.deepEqual(apres.demande, { id: active?.requestId, startedAt: active?.startedAt, plafondUsd: "2,50" });
    assert.equal(apres.activation?.dernierPlafondUsd, "2,50", "activation suivante : dernier montant proposé");
    assert.deepEqual(apres.disponibles, [{ choix: "omo", disponible: false, raison: "demande-active" }]);
    // Aucune requête à l'instance principale, jamais de redémarrage d'opencode.
    assert.equal(
      s.h.fake.requests.filter((r) => r.pathname.endsWith("/prompt_async")).length,
      0,
    );
    s.h.assertNoGlobalRestart();
  });

  it("T-L22-d : confirmation absente → 409 « confirmation-requise », aucun jeton : l'envoi suivant est refusé et rien ne part", async (t) => {
    const s = await salle(t);
    const sansConfirmation = await activer(s, { choix: "omo", plafondUsd: "1" }, s.racine, s.h.headers.mutating);
    assert.equal(sansConfirmation.status, 409, sansConfirmation.body);
    assert.deepEqual(sansConfirmation.json(), refusAttendu("confirmation-requise"));
    const envoi = await envoyer(s);
    assert.equal(envoi.status, 409);
    assert.deepEqual(envoi.body, refusAttendu("confirmation-requise"));
    assert.equal(envoisRecus(s), 0);
    assert.equal(s.service().activeRequest(), null);
    assert.equal(dernierPlafond(s), null);
  });

  it("jeton à usage unique (D-2b-07) : second envoi → 409 « jeton-consomme » ; un envoi refusé consomme aussi le jeton ; 10 minutes au plus ; un jeton par racine", async (t) => {
    const s = await salle(t);
    assert.equal((await activer(s, { choix: "omo", plafondUsd: "1" })).status, 200);
    assert.equal((await envoyer(s)).status, 204);
    const second = await envoyer(s);
    assert.equal(second.status, 409);
    assert.deepEqual(second.body, refusAttendu("jeton-consomme"));
    assert.equal(envoisRecus(s), 1, "un seul envoi");

    // Fin de la demande (répondeur, L22d) : une NOUVELLE confirmation reste exigée.
    s.service().endRequest(s.racine, "terminee");
    assert.equal((await envoyer(s)).status, 409);
    assert.equal(envoisRecus(s), 1);

    // Un envoi refusé par une condition consomme le jeton : réparer la condition ne le rend pas.
    assert.equal((await activer(s, { choix: "omo", plafondUsd: "1" })).status, 200);
    fs.rmSync(path.join(s.control, OMO_FICHIERS_CONTROLE.battement));
    assert.deepEqual((await envoyer(s)).body, refusAttendu("battement-absent"));
    s.reparer();
    assert.deepEqual((await envoyer(s)).body, refusAttendu("jeton-consomme"));

    // Pris avant même la vérification du mode : un envoi en Simple le consomme.
    assert.equal((await activer(s, { choix: "omo", plafondUsd: "1" })).status, 200);
    s.h.settings.update({ ui: { mode: "simple" } });
    const simple = await envoyer(s);
    assert.equal(simple.status, 403);
    assert.deepEqual(simple.body, refusAttendu("mode-avance"));
    s.h.settings.update({ ui: { mode: "avance" } });
    assert.deepEqual((await envoyer(s)).body, refusAttendu("jeton-consomme"));

    // Expiration : au-delà de 10 minutes, le jeton ne vaut plus rien.
    assert.equal((await activer(s, { choix: "omo", plafondUsd: "1" })).status, 200);
    s.monde.decalageMs = OMO_JETON_DUREE_MS + 1_000;
    assert.deepEqual((await envoyer(s)).body, refusAttendu("confirmation-requise"));
    s.monde.decalageMs = 0;

    // Un jeton vaut pour SA racine : confirmer « app » n'autorise pas un envoi dans la salle « autre ».
    const autre = await ouvrirSalle(s, "autre");
    assert.equal((await activer(s, { choix: "omo", plafondUsd: "1" })).status, 200);
    assert.deepEqual((await envoyer(s, autre)).body, refusAttendu("confirmation-requise"));
    assert.equal(envoisRecus(s), 1, "rien d'autre n'est parti");
    assert.equal((await envoyer(s)).status, 204, "le jeton de « app » est resté intact");
    assert.equal(envoisRecus(s), 2);
  });

  it("D-2b-08 : une seule demande active dans la salle ; deux envois confirmés en même temps → un seul part, l'autre 409 « demande-active »", async (t) => {
    const s = await salle(t);
    const autre = await ouvrirSalle(s, "autre");
    assert.equal((await activer(s, { choix: "omo", plafondUsd: "1" })).status, 200);
    assert.equal((await activer(s, { choix: "omo", plafondUsd: "1" }, autre)).status, 200);
    const [a, b] = await Promise.all([envoyer(s), envoyer(s, autre)]);
    assert.deepEqual([a.status, b.status].sort(), [204, 409]);
    assert.deepEqual((a.status === 409 ? a : b).body, refusAttendu("demande-active"));
    assert.equal(envoisRecus(s), 1);
    // Pendant la demande : une activation ailleurs est refusée, sans file d'attente.
    const pendant = await activer(s, { choix: "omo", plafondUsd: "1" }, a.status === 409 ? s.racine : autre);
    assert.equal(pendant.status, 409);
    assert.deepEqual(pendant.json(), refusAttendu("demande-active"));
  });
});

// --- Montant saisi ----------------------------------------------------------------------------------------------------------

describe("L22c : montant d'arrêt saisi (omo-cap.ts, vérifié par le serveur)", () => {
  it("T-L22-e et T-L22-f : vide, absent, nul, négatif, non numérique, nombre JSON, au-dessus de plafondMaxUsd → 409 et sa phrase ; aucun jeton, RIEN n'est envoyé", async (t) => {
    const s = await salle(t);
    const cas: Array<[unknown, OmoActivationRefusalCode]> = [
      [undefined, "plafond-vide"],
      ["", "plafond-vide"],
      ["   ", "plafond-vide"],
      ["0", "plafond-invalide"],
      ["0,00", "plafond-invalide"],
      ["-1", "plafond-invalide"],
      ["abc", "plafond-invalide"],
      ["1e2", "plafond-invalide"],
      ["1,234", "plafond-invalide"],
      [2, "plafond-invalide"],
      [null, "plafond-invalide"],
      ["5,01", "plafond-hors-bornes"],
      ["12", "plafond-hors-bornes"],
    ];
    for (const [plafondUsd, code] of cas) {
      const corps = plafondUsd === undefined ? { choix: "omo" } : { choix: "omo", plafondUsd };
      const res = await activer(s, corps);
      assert.equal(res.status, 409, `${JSON.stringify(plafondUsd)} : ${res.body}`);
      assert.deepEqual(res.json(), refusAttendu(code), JSON.stringify(plafondUsd));
      assert.deepEqual((await envoyer(s)).body, refusAttendu("confirmation-requise"), `aucun jeton après ${JSON.stringify(plafondUsd)}`);
    }
    assert.equal(envoisRecus(s), 0, "rien n'est parti");
    assert.equal(dernierPlafond(s), null, "aucun refus n'écrit le dernier montant");
    // Borne comprise : 5 $ tout juste passe.
    assert.equal((await activer(s, { choix: "omo", plafondUsd: "5" })).status, 200);
  });

  it("T-L22-f à l'envoi : la borne baisse entre la confirmation et l'envoi → 409 « plafond-hors-bornes », rien n'est envoyé", async (t) => {
    const s = await salle(t);
    assert.equal((await activer(s, { choix: "omo", plafondUsd: "4" })).status, 200);
    s.h.settings.update({ budget: { autonomie: { plafondMaxUsd: 3 } } });
    const envoi = await envoyer(s);
    assert.equal(envoi.status, 409);
    assert.equal(envoi.body?.raison, "plafond-hors-bornes");
    assert.equal(envoisRecus(s), 0);
    assert.equal(dernierPlafond(s), null);
  });

  it("T-L22-g : garde-fou budgétaire → 409 « budget-mensuel », à l'activation (budget épuisé) comme à l'envoi (modèle de l'envoi refusé, jamais confirmé)", async (t) => {
    const s = await salle(t);
    s.monde.budget.pourcent = 100;
    const res = await activer(s, { choix: "omo", plafondUsd: "1" });
    assert.equal(res.status, 409);
    assert.deepEqual(res.json(), refusAttendu("budget-mensuel"));
    const vue = await vueSalle(s);
    assert.deepEqual(
      vue.activation?.conditions.find((c) => c.code === "budget-mensuel"),
      { code: "budget-mensuel", ok: false },
      "l'écran lit le refus du garde-fou avant d'envoyer",
    );
    s.monde.budget.pourcent = 0;
    assert.equal((await activer(s, { choix: "omo", plafondUsd: "1" })).status, 200);
    s.monde.budget.modeleAutorise = false;
    const envoi = await envoyer(s);
    assert.equal(envoi.status, 409);
    assert.deepEqual(envoi.body, refusAttendu("budget-mensuel"));
    assert.equal(envoisRecus(s), 0);
  });
});

// --- Conditions du §4.14.2, revérifiées à l'envoi ---------------------------------------------------------------------------

interface CasCondition {
  nom: string;
  code: OmoActivationRefusalCode;
  liste?: string[];
  /** Suite de la phrase (D5) : commande qui impose l'adresse vérifiée, quand aucune adresse n'est imposée. */
  suite?: string;
  casser(s: Salle): void;
}

const CONDITIONS: CasCondition[] = [
  { nom: "salle coupée (SALLE_OUVERTE)", code: "salle-coupee", casser: (s) => void (s.monde.salleOuverte = false) },
  { nom: "salle coupée (aucune instance de la salle)", code: "salle-coupee", casser: (s) => void (s.monde.instance = false) },
  { nom: "COCKPIT_AUTONOMY=off (décision n° 13)", code: "autonomie-coupee", casser: (s) => void (s.monde.autonomie = false) },
  { nom: "salle suspendue", code: "salle-suspendue", casser: (s) => void (s.monde.suspendue = true) },
  { nom: "battement absent", code: "battement-absent", casser: (s) => fs.rmSync(path.join(s.control, OMO_FICHIERS_CONTROLE.battement)) },
  {
    nom: "battement périmé (au-delà de perimeS, le superviseur arrête la salle)",
    code: "battement-absent",
    casser: (s) => fs.writeFileSync(path.join(s.control, OMO_FICHIERS_CONTROLE.battement), ecrireBattement(Date.now() - (OMO_DELAIS.perimeS + 1) * 1000), "utf8"),
  },
  { nom: "state.json illisible (salle en relance)", code: "salle-en-relance", casser: (s) => void (s.monde.etat = null) },
  { nom: "salle en relance (phase arret)", code: "salle-en-relance", casser: (s) => void ((s.monde.etat as OmoSupervisorState).phase = "arret") },
  { nom: "opencode pas encore lancé (phase attente)", code: "salle-en-relance", casser: (s) => void ((s.monde.etat as OmoSupervisorState).phase = "attente") },
  {
    nom: "nouveau démarrage pas encore pré-contrôlé (precheck-ok d'un autre démarrage)",
    code: "salle-en-relance",
    casser: (s) => void ((s.monde.etat as OmoSupervisorState).startId = AUTRE_START_ID),
  },
  // Relecture 2ter-vague-4 : la relance à neuf est décidée par le cockpit, mais le superviseur ne l'a pas encore faite (il relit
  // stop-request toutes les 2 s) : state.json dit encore « opencode-lance » pour l'opencode que le cockpit vient de faire arrêter.
  {
    nom: "stop-request du démarrage publié, superviseur pas encore passé (fin de demande)",
    code: "salle-en-relance",
    casser: (s) => fs.writeFileSync(path.join(s.control, OMO_FICHIERS_CONTROLE.arret), ecrireArret(Date.now(), "fin-de-demande", START_ID), "utf8"),
  },
  {
    nom: "stop-request sans démarrage nommé (état inconnu à l'écriture), daté du démarrage publié ou d'après",
    code: "salle-en-relance",
    casser: (s) => fs.writeFileSync(path.join(s.control, OMO_FICHIERS_CONTROLE.arret), ecrireArret(Date.now(), "vous", null), "utf8"),
  },
  {
    nom: "arrêt ou relance en cours côté cockpit, stop-request pas encore écrit (demande déjà close, abandon des sessions)",
    code: "salle-en-relance",
    casser: (s) => void (s.monde.arretEnCours = true),
  },
  { nom: "manifeste en écart", code: "manifeste", casser: (s) => void ((s.monde.etat as OmoSupervisorState).manifesteReference = "ecart") },
  { nom: "manifeste : amorce", code: "manifeste", casser: (s) => void ((s.monde.etat as OmoSupervisorState).manifesteReference = "amorce") },
  { nom: "validation de l'image en échec", code: "manifeste", casser: (s) => void ((s.monde.etat as OmoSupervisorState).validation = "echec") },
  {
    nom: "image d'une autre version que celle auditée",
    code: "image-inattendue",
    casser: (s) => void ((s.monde.etat as OmoSupervisorState).imageId = `oh-my-openagent@4.19.3 base=sha256:${SHA}`),
  },
  { nom: "aucune image installée par install.ps1 (COCKPIT_OMO_IMAGE vide)", code: "image-inattendue", casser: (s) => void (s.monde.image = "") },
  {
    nom: ".git du projet inscriptible (sonde étendue : alias du .git ou du parent)",
    code: "git-inscriptible",
    liste: ["app"],
    casser: (s) => void ((s.monde.etat as OmoSupervisorState).projets[0] = { chemin: "app", gitLectureSeule: false }),
  },
  {
    nom: "A16 : racine du dossier de travail sans lecture seule (« . » publié par la sonde de L16c)",
    code: "git-inscriptible",
    liste: ["."],
    casser: (s) => void ((s.monde.etat as OmoSupervisorState).workspaceGit.nonProteges = ["."]),
  },
  {
    nom: "A16 : montage en écriture sur un alias de .git",
    code: "git-inscriptible",
    liste: ["app/.GIT"],
    casser: (s) => void ((s.monde.etat as OmoSupervisorState).workspaceGit.nonProteges = ["app/.GIT"]),
  },
  {
    nom: "A16 : sonde dans le doute (balayage incomplet) → fermé",
    code: "git-inscriptible",
    casser: (s) => void ((s.monde.etat as OmoSupervisorState).workspaceGit.limiteAtteinte = true),
  },
  {
    nom: "projet de la salle absent de l'état publié → fermé",
    code: "git-inscriptible",
    liste: ["app"],
    casser: (s) => void ((s.monde.etat as OmoSupervisorState).projets = [{ chemin: "autre", gitLectureSeule: true }]),
  },
  {
    nom: "pré-contrôle frais du projet refusé",
    code: "precheck-refuse",
    casser: (s) => void (s.monde.precheck = (projet) => ({ ok: true, resultat: { projet, verdict: "refuse", raison: "config-extension", trouves: [".omo/omo.jsonc"] } })),
  },
  { nom: "pré-contrôle impossible", code: "precheck-refuse", casser: (s) => void (s.monde.precheck = () => ({ ok: false, code: "salle-coupee" })) },
  {
    nom: "dossier de configuration du HOME non conforme",
    code: "precheck-refuse",
    casser: (s) => void ((s.monde.etat as OmoSupervisorState).dossiersConfig[1] = { chemin: "/home/node/.omo", ok: false }),
  },
  { nom: "dossiers de configuration non publiés", code: "precheck-refuse", casser: (s) => void ((s.monde.etat as OmoSupervisorState).dossiersConfig = []) },
  {
    nom: "démarrage pré-contrôlé et refusé (aucun precheck-ok pour lui)",
    code: "precheck-refuse",
    casser: (s) => {
      (s.monde.etat as OmoSupervisorState).startId = AUTRE_START_ID;
      s.h.db
        .prepare("INSERT INTO omo_room_starts (start_id, started_at, image_id, manifest_sha256, precheck, cause) VALUES (?, ?, ?, ?, '[]', 'demarrage')")
        .run(AUTRE_START_ID, Date.now(), "image", SHA);
    },
  },
  {
    nom: "relecture 2bis-vague-0 : .git hors gitProteges apparu APRÈS le démarrage (profondeur 2), state.json toujours vert",
    code: "workspace-non-verifie",
    liste: ["app/vendored/.git"],
    casser: (s) => fs.mkdirSync(path.join(s.workspace, "app", "vendored", ".git"), { recursive: true }),
  },
  { nom: "omo-projets.json absent : balayage non vérifiable", code: "workspace-non-verifie", casser: (s) => void (s.monde.projetsFichier = null) },
  { nom: "balayage du cockpit tronqué (bornes)", code: "workspace-non-verifie", casser: (s) => void (s.monde.bornes = { balayageGitEntreesMax: 1 }) },
  { nom: "catalogue non chargé", code: "catalogue-absent", casser: (s) => void (s.monde.catalogue.loaded = false) },
  { nom: "catalogue non vérifié auprès de GitHub Copilot", code: "catalogue-absent", casser: (s) => void (s.monde.catalogue.copilotVerified = false) },
  { nom: "aucune IA Copilot au catalogue", code: "catalogue-absent", casser: (s) => void (s.monde.catalogue.copilot = false) },
  { nom: "catalogue illisible", code: "catalogue-absent", casser: (s) => void (s.monde.catalogue.leve = true) },
  {
    nom: "adresse Copilot du compte ≠ adresse autorisée à la salle",
    code: "adresse-copilot-changee",
    // Grande fusion, D5 : sans adresse imposée, la phrase donne la commande qui impose l'adresse vérifiée.
    suite: phraseAdresseAImposer("https://api.business.githubcopilot.com"),
    casser: (s) => void (s.monde.catalogue.endpoint = "https://api.business.githubcopilot.com"),
  },
  { nom: "adresse Copilot du compte inconnue", code: "adresse-copilot-changee", casser: (s) => void (s.monde.catalogue.endpoint = null) },
];

describe("L22c : conditions du §4.14.2, 409 et phrase, rien n'est envoyé", () => {
  it("T-L22-j : chaque condition fausse → 409 et sa phrase À L'ACTIVATION, puis de nouveau À L'ENVOI (condition cassée après la confirmation), sans aucun envoi", async (t) => {
    const s = await salle(t);
    for (const cas of CONDITIONS) {
      s.reparer();
      cas.casser(s);
      const put = await activer(s, { choix: "omo", plafondUsd: "1" });
      assert.equal(put.status, 409, `${cas.nom} (activation) : ${put.body}`);
      assert.deepEqual(put.json(), refusAttendu(cas.code, cas.liste, cas.suite), `${cas.nom} (activation)`);

      s.reparer();
      const confirme = await activer(s, { choix: "omo", plafondUsd: "1" });
      assert.equal(confirme.status, 200, `${cas.nom} (réparé) : ${confirme.body}`);
      cas.casser(s);
      const envoi = await envoyer(s);
      assert.equal(envoi.status, 409, `${cas.nom} (envoi) : ${JSON.stringify(envoi.body)}`);
      assert.deepEqual(envoi.body, refusAttendu(cas.code, cas.liste, cas.suite), `${cas.nom} (envoi)`);
      assert.equal(envoisRecus(s), 0, `${cas.nom} : rien n'est envoyé`);
      assert.equal(s.service().activeRequest(), null, cas.nom);
    }
    assert.equal(dernierPlafond(s), null, "aucun refus n'écrit le dernier montant");
    // Le monde réparé laisse bien passer : les refus ci-dessus viennent de la condition cassée, pas du montage.
    s.reparer();
    assert.equal((await activer(s, { choix: "omo", plafondUsd: "1" })).status, 200);
    assert.equal((await envoyer(s)).status, 204);
  });

  it("relecture 2ter-vague-4 : un stop-request déjà honoré (démarrage précédent, ou daté d'avant le démarrage publié) ne retient rien", async (t) => {
    const s = await salle(t);
    const arret = path.join(s.control, OMO_FICHIERS_CONTROLE.arret);
    const debut = (s.monde.etat as OmoSupervisorState).startedAt;
    for (const texte of [ecrireArret(Date.now(), "fin-de-demande", AUTRE_START_ID), ecrireArret(debut - 1, "vous", null)]) {
      fs.writeFileSync(arret, texte, "utf8");
      const put = await activer(s, { choix: "omo", plafondUsd: "1" });
      assert.equal(put.status, 200, `${texte} : ${put.body}`);
    }
    assert.equal((await envoyer(s)).status, 204);
    assert.equal(envoisRecus(s), 1);
  });

  it("T-L22-j : COCKPIT_AUTONOMY=off dans l'environnement du cockpit → 409 « autonomie-coupee », la vue le dit", async (t) => {
    const s = await salle(t, { env: { autonomy: false } });
    s.monde.autonomie = false;
    const res = await activer(s, { choix: "omo", plafondUsd: "1" });
    assert.equal(res.status, 409);
    assert.deepEqual(res.json(), refusAttendu("autonomie-coupee"));
    const vue = await vueSalle(s);
    assert.equal(vue.interrupteur, false);
    assert.deepEqual(vue.disponibles, [{ choix: "omo", disponible: false, raison: "autonomie-coupee" }]);
  });

  // Grande fusion, décision D5 (fiche v106 §3.6) : egress n'ouvre que l'adresse imposée, sinon celle d'office. Sans adresse
  // imposée et avec une adresse vérifiée d'abonnement, chaque envoi de la salle partirait vers api.githubcopilot.com, refusé et
  // journalisé par le proxy de l'entreprise (A19) : refus, avec la commande qui impose l'adresse vérifiée.
  it("D5 : COCKPIT_COPILOT_API_URL vide et adresse vérifiée ≠ adresse d'office → 409, phrase avec -CopilotApiUrl ; permis dans les autres cas", async (t) => {
    const BUSINESS = "https://api.business.githubcopilot.com";
    const s = await salle(t);
    s.monde.catalogue.endpoint = `${BUSINESS}/`;
    const refus = await activer(s, { choix: "omo", plafondUsd: "1" });
    assert.equal(refus.status, 409, refus.body);
    assert.deepEqual(refus.json(), refusAttendu("adresse-copilot-changee", [], phraseAdresseAImposer(BUSINESS)));
    assert.match(refus.json<{ message: string }>().message, /\.\\install\.ps1 -CopilotApiUrl https:\/\/api\.business\.githubcopilot\.com$/);
    assert.equal(envoisRecus(s), 0);
    // Permis : adresse vérifiée = adresse d'office, sans adresse imposée.
    s.monde.catalogue.endpoint = ENDPOINT_PAR_DEFAUT;
    assert.equal((await activer(s, { choix: "omo", plafondUsd: "1" })).status, 200);

    // Adresse imposée (celle de l'abonnement) et vérifiée identique : permis, egress l'ouvre.
    const imposee = await salle(t, { env: { copilotApiUrl: BUSINESS } });
    imposee.monde.catalogue.endpoint = BUSINESS;
    const permis = await activer(imposee, { choix: "omo", plafondUsd: "1" });
    assert.equal(permis.status, 200, permis.body);
    // Adresse imposée mais une autre vérifiée : refus « Adresse Copilot changée » SANS la suite D5 (l'adresse est déjà imposée).
    imposee.monde.catalogue.endpoint = "https://api.enterprise.githubcopilot.com";
    const change = await activer(imposee, { choix: "omo", plafondUsd: "1" });
    assert.equal(change.status, 409, change.body);
    assert.deepEqual(change.json(), refusAttendu("adresse-copilot-changee"));
    // Adresse vérifiée hors des hôtes Copilot connus : aucune commande proposée (install.ps1 la refuserait), refus sans suite.
    s.monde.catalogue.endpoint = "https://copilot.exemple.test";
    assert.deepEqual((await activer(s, { choix: "omo", plafondUsd: "1" })).json(), refusAttendu("adresse-copilot-changee"));
  });

  it("vue de l'écran : toutes les conditions relevées, première fausse en raison ; salle coupée : rien d'autre n'est lu", async (t) => {
    const s = await salle(t);
    fs.rmSync(path.join(s.control, OMO_FICHIERS_CONTROLE.battement));
    s.monde.catalogue.loaded = false;
    const vue = await vueSalle(s);
    assert.deepEqual(vue.disponibles, [{ choix: "omo", disponible: false, raison: "battement-absent" }]);
    const fausses = vue.activation?.conditions.filter((c) => !c.ok).map((c) => c.code);
    assert.deepEqual(fausses, ["battement-absent", "catalogue-absent"]);
    s.reparer();
    s.monde.salleOuverte = false;
    const coupee = await vueSalle(s);
    assert.deepEqual(coupee.activation?.conditions, [{ code: "salle-coupee", ok: false }]);
  });
});

// --- Racines et modes (réservations 1 et 2) ---------------------------------------------------------------------------------

describe("L22c : racines et modes (réservations 1 et 2)", () => {
  it("T-L22-l : racine principale → 409 « racine-hors-salle » dans les deux modes, sans consulter l'activation ; racine suivie de la salle sans salle ouverte → 409", async (t) => {
    const s = await salle(t);
    const principale = await s.h.call("POST", "/api/oc/session", { headers: s.h.headers.mutating, body: { title: "Principale" } });
    assert.equal(principale.status, 200, principale.body);
    const { id } = principale.json<{ id: string }>();
    for (const mode of ["simple", "avance"] as const) {
      s.h.settings.update({ ui: { mode } });
      const res = await activer(s, { choix: "omo", plafondUsd: "1" }, id);
      assert.equal(res.status, 409, `${mode} : ${res.body}`);
      assert.deepEqual(res.json(), refusAttendu("racine-hors-salle"));
    }
    assert.equal(s.appelsPut(), 0, "le port d'activation n'est jamais consulté pour une racine principale");
    // Racine de l'instance « omo » que le cockpit suit, mais qui n'est pas une salle ouverte (aucune ligne omo_rooms).
    const orpheline = await ouvrirSalle(s, null);
    const res = await activer(s, { choix: "omo", plafondUsd: "1" }, orpheline);
    assert.equal(res.status, 409);
    assert.deepEqual(res.json(), refusAttendu("racine-hors-salle"));
    assert.deepEqual((await envoyer(s, orpheline)).body, refusAttendu("confirmation-requise"));
    assert.equal(envoisRecus(s), 0);
  });

  it("T-L22-l : mode Simple → 403 « mode-avance » en lecture comme en écriture, rien n'est préparé ; tout autre choix que « omo » sur une salle → 409", async (t) => {
    const s = await salle(t, { mode: "simple" });
    const get = await s.h.call("GET", url(s.racine), { headers: s.h.headers.authed });
    assert.equal(get.status, 403);
    assert.deepEqual(get.json(), refusAttendu("mode-avance"));
    const put = await activer(s, { choix: "omo", plafondUsd: "1" });
    assert.equal(put.status, 403);
    assert.deepEqual(put.json(), refusAttendu("mode-avance"));
    assert.equal(s.appelsPut(), 0);
    // Le port lui-même refuse le mode Simple (défense en profondeur : il ne dépend pas de l'aiguillage de la route).
    assert.deepEqual(await s.service().put(s.racine, { choix: "omo", plafondUsd: "1" }, { mode: "simple", confirmed: true }), {
      ok: false,
      status: 403,
      code: "mode-avance",
    });
    s.h.settings.update({ ui: { mode: "avance" } });
    assert.deepEqual((await envoyer(s)).body, refusAttendu("confirmation-requise"), "aucun jeton préparé en Simple");
    for (const choix of ["autonome", "modifications", "demander", "plan"]) {
      const autre = await activer(s, { choix });
      assert.equal(autre.status, 409, `${choix} : ${autre.body}`);
      assert.equal(autre.json<{ error: string }>().error, "autonomie-indisponible");
    }
    assert.equal(new ConversationAutonomyStore(s.h.db).read(s.racine), null, "rien n'est écrit");
  });

  it("un envoi sur une conversation de l'extension (enfant de la salle) → 409 « racine-hors-salle », le jeton de la racine n'est pas pris", async (t) => {
    const s = await salle(t);
    const enfant = await ouvrirSalle(s, "app", s.racine);
    assert.equal(s.h.sessions.rootOf(enfant), s.racine);
    assert.equal((await activer(s, { choix: "omo", plafondUsd: "1" })).status, 200);
    const refus = await envoyer(s, enfant);
    assert.equal(refus.status, 409);
    assert.deepEqual(refus.body, refusAttendu("racine-hors-salle"));
    assert.equal(envoisRecus(s), 0);
    assert.equal((await envoyer(s)).status, 204, "le jeton de la racine est intact");
  });

  it("le crochet ne juge que la salle : un contexte de l'instance principale n'est jamais refusé ni consommé", async (t) => {
    const s = await salle(t);
    assert.equal((await activer(s, { choix: "omo", plafondUsd: "1" })).status, 200);
    const verdict = await s.service().hook({ c: {} as never, method: "POST", sub: `/session/${s.racine}/prompt_async`, directory: null, body: {}, sessionId: s.racine });
    assert.equal(verdict, null);
    assert.equal((await envoyer(s)).status, 204, "jeton intact");
  });
});

// --- dernierPlafondUsd (D-2b-11) et aucune valeur par défaut (Q7) -----------------------------------------------------------

describe("L22c : dernier montant (D-2b-11) et aucune valeur de plafond par défaut (Q7)", () => {
  it("T-L22-h : dernierPlafondUsd jamais écrit par un refus, ni par PUT /api/settings (deux modes), ni par la réinitialisation", async (t) => {
    const s = await salle(t);
    // Refus : activation refusée, envoi refusé.
    assert.equal((await activer(s, { choix: "omo", plafondUsd: "9" })).status, 409);
    assert.equal((await activer(s, { choix: "omo", plafondUsd: "3" })).status, 200);
    s.monde.suspendue = true;
    assert.equal((await envoyer(s)).status, 409);
    s.monde.suspendue = false;
    assert.equal(dernierPlafond(s), null);
    // Activation confirmée par l'envoi : seul écrivain.
    assert.equal((await activer(s, { choix: "omo", plafondUsd: "1,50" })).status, 200);
    assert.equal((await envoyer(s)).status, 204);
    assert.equal(dernierPlafond(s), "1,50");

    for (const mode of ["avance", "simple"] as const) {
      s.h.settings.update({ ui: { mode } });
      for (const corps of [{ budget: { omo: { dernierPlafondUsd: "3" } } }, { budget: { omo: { dernierPlafondUsd: null } } }, { budget: { omo: null } }, { budget: { omo: { autre: 1, dernierPlafondUsd: "4" } } }]) {
        const res = await s.h.call("PUT", "/api/settings", { headers: s.h.headers.mutating, body: corps });
        assert.equal(res.status, 403, `${mode} ${JSON.stringify(corps)} : ${res.body}`);
        assert.equal(res.json<{ error: string }>().error, "reglage-fixe");
      }
      // Renvoyer la valeur en vigueur ne change rien et passe (un écran qui renvoie tout le budget reste utilisable).
      const inchange = await s.h.call("PUT", "/api/settings", { headers: s.h.headers.mutating, body: { budget: { monthlyUsd: 40, omo: { dernierPlafondUsd: "1,50" } } } });
      assert.equal(inchange.status, 200, `${mode} : ${inchange.body}`);
    }
    s.h.settings.update({ ui: { mode: "avance" } });
    // `budget` remplacé par autre chose qu'un objet : refusé par le schéma, rien d'écrit.
    const bloc = await s.h.call("PUT", "/api/settings", { headers: s.h.headers.mutating, body: { budget: null } });
    assert.equal(bloc.status, 422, bloc.body);
    assert.equal(dernierPlafond(s), "1,50");

    // Réinitialisation de la section « budget » : tout revient d'office, sauf le dernier montant.
    const reset = await s.h.call("POST", "/api/settings/reset", { headers: s.h.headers.mutating, body: { section: "budget" } });
    assert.equal(reset.status, 200, reset.body);
    assert.equal(s.h.settings.get().budget.monthlyUsd, DEFAULT_SETTINGS.budget.monthlyUsd);
    assert.equal(dernierPlafond(s), "1,50");
    // Et en mode Simple (seule section permise).
    s.h.settings.update({ ui: { mode: "simple" } });
    assert.equal((await s.h.call("POST", "/api/settings/reset", { headers: s.h.headers.mutating, body: { section: "budget" } })).status, 200);
    assert.equal(dernierPlafond(s), "1,50");
  });

  it("réglage enregistré illisible : relu null (champ vide), jamais remplacé par un montant, sans perdre les autres réglages", async (t) => {
    const s = await salle(t);
    s.h.settings.update({ budget: { monthlyUsd: 77 } });
    const brut = JSON.parse((s.h.db.prepare("SELECT value FROM settings WHERE key = 'cockpit'").get() as { value: string }).value) as Record<string, Record<string, unknown>>;
    for (const valeur of ["abc", "-1", "1,234", 12, { montant: 1 }]) {
      const altere = { ...brut, budget: { ...brut.budget, omo: { dernierPlafondUsd: valeur } } };
      s.h.db.prepare("UPDATE settings SET value = ? WHERE key = 'cockpit'").run(JSON.stringify(altere));
      const relu = new SettingsStore(s.h.db).get();
      assert.equal(relu.budget.omo.dernierPlafondUsd, null, JSON.stringify(valeur));
      assert.equal(relu.budget.monthlyUsd, 77, `${JSON.stringify(valeur)} : les autres réglages restent lus`);
    }
  });

  it("T-L22-i : aucune valeur de plafond par défaut — réglages d'office, serveur (jamais le dernier montant à la place d'un champ vide), limites, configuration et code", async (t) => {
    assert.deepEqual(DEFAULT_SETTINGS.budget.omo, { dernierPlafondUsd: null });
    for (const cle of Object.keys(OMO_LIMITES)) assert.doesNotMatch(cle, /plafond|usd|cout|cost/i, cle);

    const s = await salle(t);
    assert.equal((await activer(s, { choix: "omo", plafondUsd: "2" })).status, 200);
    assert.equal((await envoyer(s)).status, 204);
    s.service().endRequest(s.racine, "terminee");
    assert.equal(dernierPlafond(s), "2");
    // Le dernier montant est PROPOSÉ par l'écran ; le serveur ne l'utilise jamais pour un champ vide ou absent.
    for (const corps of [{ choix: "omo" }, { choix: "omo", plafondUsd: "" }]) {
      const res = await activer(s, corps);
      assert.equal(res.status, 409);
      assert.equal(res.json<{ raison: string }>().raison, "plafond-vide");
    }

    // Configuration : aucune variable de plafond pour le cockpit ni pour la salle.
    const racineDepot = path.resolve(import.meta.dirname, "..", "..");
    const contrat = JSON.parse(fs.readFileSync(path.join(racineDepot, "docker", "opencode-omo", "contrat-salle.json"), "utf8")) as { variables: { cockpit: string[]; salle: string[] } };
    for (const nom of [...contrat.variables.cockpit, ...contrat.variables.salle]) assert.doesNotMatch(nom, /PLAFOND|CAP_|USD/, nom);
    assert.doesNotMatch(fs.readFileSync(path.join(racineDepot, "docker-compose.yml"), "utf8"), /PLAFOND/i);
    // Code : aucun dernier montant écrit par une valeur littérale, côté serveur comme côté interface.
    const fichiers: string[] = [];
    const parcourir = (dossier: string) => {
      for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
        const complet = path.join(dossier, entree.name);
        if (entree.isDirectory() && entree.name !== "node_modules" && entree.name !== "test-support") parcourir(complet);
        else if (entree.isFile() && /\.tsx?$/.test(entree.name) && !entree.name.endsWith(".test.ts")) fichiers.push(complet);
      }
    };
    parcourir(path.join(racineDepot, "app", "server"));
    parcourir(path.join(racineDepot, "app", "web"));
    assert.ok(fichiers.length > 50);
    for (const fichier of fichiers) {
      assert.doesNotMatch(fs.readFileSync(fichier, "utf8"), /dernierPlafondUsd\s*[:=]\s*["'`0-9]/, fichier);
    }
  });
});

// --- Redémarrage du cockpit (réservation 3, §4.11, décision n° 10) ------------------------------------------------------------

describe("L22c : redémarrage du cockpit pendant une demande", () => {
  it("T-L22-m : la demande devient « interrompue » (fait statut), le choix reste « omo », le jeton est perdu : nouvelle confirmation exigée", async (t) => {
    const s = await salle(t);
    assert.equal((await activer(s, { choix: "omo", plafondUsd: "2,50" })).status, 200);
    assert.equal((await envoyer(s)).status, 204);
    const demande = s.service().activeRequest();
    assert.ok(demande);
    // Une confirmation en attente d'envoi, dans une autre salle, avant le redémarrage.
    const autre = await ouvrirSalle(s, "autre");
    const faitsAvant = s.facts.length;

    await s.redemarrer();

    const ligne = ligneOmo(s);
    assert.deepEqual([ligne?.demande, ligne?.retourCause, ligne?.plafondUsd], [null, "interrompue", "2,50"]);
    assert.deepEqual(
      s.facts.slice(faitsAvant).map((f) => ({ rootId: f.rootId, kind: f.kind, data: f.data })),
      [{ rootId: s.racine, kind: "statut", data: { cause: "interrompue", motif: "redemarrage-cockpit" } }],
    );
    const vue = await vueSalle(s);
    assert.deepEqual([vue.choix, vue.retourCause, vue.demande], ["omo", "interrompue", null]);
    assert.deepEqual(vue.disponibles, [{ choix: "omo", disponible: true, raison: null }]);
    assert.equal(vue.activation?.dernierPlafondUsd, "2,50", "montant saisi ou validé à nouveau : le dernier est proposé");
    assert.equal(s.service().activeRequest(), null);

    // Jeton perdu : sans nouvelle confirmation, rien ne part.
    assert.deepEqual((await envoyer(s)).body, refusAttendu("confirmation-requise"));
    assert.deepEqual((await envoyer(s, autre)).body, refusAttendu("confirmation-requise"));
    assert.equal(envoisRecus(s), 1);
    assert.equal((await activer(s, { choix: "omo", plafondUsd: "2,50" })).status, 200);
    assert.equal((await envoyer(s)).status, 204);
    assert.equal(envoisRecus(s), 2);

    // La demande lancée par CE démarrage n'est jamais touchée par une étape de démarrage rejouée.
    const nouvelle = s.service().activeRequest();
    const faits = s.facts.length;
    await s.h.cockpit.startup();
    assert.equal(ligneOmo(s)?.demande?.id, nouvelle?.requestId);
    assert.equal(s.facts.length, faits);
    assert.deepEqual(interruptSalleAtStartup(s.h.cockpit.c11), []);
  });

  it("fin de demande (répondeur, arrêt) : endRequest libère la salle ; « redemarrage-cockpit » la dit interrompue ; une autre racine ne touche à rien", async (t) => {
    const s = await salle(t);
    assert.equal((await activer(s, { choix: "omo", plafondUsd: "1" })).status, 200);
    assert.equal((await envoyer(s)).status, 204);
    const autre = await ouvrirSalle(s, "autre");
    s.service().endRequest(autre, "terminee");
    assert.notEqual(s.service().activeRequest(), null, "fin d'une autre racine : sans effet");
    s.service().endRequest(s.racine, "redemarrage-cockpit");
    assert.equal(s.service().activeRequest(), null);
    assert.deepEqual([ligneOmo(s)?.demande, ligneOmo(s)?.retourCause], [null, "interrompue"]);
    assert.equal((await activer(s, { choix: "omo", plafondUsd: "1" })).status, 200);
    assert.equal((await envoyer(s)).status, 204);
    s.service().endRequest(s.racine, "terminee");
    assert.deepEqual([ligneOmo(s)?.demande, ligneOmo(s)?.retourCause], [null, null]);
  });
});

// --- Installation (dépôt livré : salle coupée) ----------------------------------------------------------------------------

describe("L22c : installation du module", () => {
  it("dépôt livré (SALLE_OUVERTE faux) : le port NEUTRE reste en place et rien n'est inscrit, même avec la salle configurée", async (t) => {
    const h = await startCockpit(t, { omo: true, modules: ["omoActivation"] });
    assert.equal(h.cockpit.c11.salleOuverte, false);
    assert.deepEqual(
      h.cockpit.wiring.registrations.filter((r) => r.module === "omoActivation"),
      [],
    );
    const port = h.cockpit.c11.ports.omoActivation;
    assert.deepEqual(await port.put("ses_x", { choix: "omo", plafondUsd: "1" }, { mode: "avance", confirmed: true }), { ok: false, status: 409, code: "salle-coupee" });
    assert.deepEqual(await port.consume("ses_x"), { ok: false, code: "salle-coupee" });
    assert.equal(port.activeRequest(), null);
    // Le port neutre reste celui de T3b, exporté et inchangé.
    assert.deepEqual(await neutralOmoActivation(h.cockpit.c11).put("ses_x", { choix: "omo", plafondUsd: "1" }, { mode: "avance", confirmed: true }), {
      ok: false,
      status: 409,
      code: "salle-coupee",
    });
  });

  it("salle ouverte (copie de banc) : port réel posé et crochet beforeBilledSend inscrit pour la salle SEULE ; sans dossiers de contrôle, rien", async (t) => {
    let service: OmoActivationService | null = null;
    const module: Cockpit11Module = {
      name: "omoActivation",
      install(reg, c11) {
        service = installOmoActivation(reg, c11, { salleOuverte: () => true });
      },
    };
    const h = await startCockpit(t, { omo: true, modules: [module] });
    assert.ok(service);
    assert.equal(h.cockpit.c11.ports.omoActivation, service);
    assert.deepEqual(
      h.cockpit.wiring.registrations.filter((r) => r.module === "omoActivation"),
      [{ kind: "hook", key: "beforeBilledSend", module: "omoActivation", instances: ["omo"] }],
    );

    let sansDossiers: OmoActivationService | null | undefined;
    const module2: Cockpit11Module = {
      name: "omoActivation",
      install(reg, c11) {
        sansDossiers = installOmoActivation(reg, { ...c11, omoControlDirs: null } as Cockpit11, { salleOuverte: () => true });
      },
    };
    const h2 = await startCockpit(t, { modules: [module2] });
    assert.equal(sansDossiers, null);
    assert.deepEqual(
      h2.cockpit.wiring.registrations.filter((r) => r.module === "omoActivation"),
      [],
    );
  });
});

// --- Journal : ni secret ni montant, rien d'inventé ------------------------------------------------------------------------------

describe("L22c : journal", () => {
  it("les lignes du journal de l'activation ne portent ni corps d'envoi, ni mot de passe, ni en-tête", async (t) => {
    const s = await salle(t);
    assert.equal((await activer(s, { choix: "omo", plafondUsd: "1" })).status, 200);
    fs.rmSync(path.join(s.control, OMO_FICHIERS_CONTROLE.battement));
    assert.equal((await envoyer(s)).status, 409);
    const texte = JSON.stringify(s.journal);
    assert.match(texte, /envoi refusé, rien n'est envoyé/);
    assert.doesNotMatch(texte, /Bonjour|password|authorization|cookie/i);
  });
});
