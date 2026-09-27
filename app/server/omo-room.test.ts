// Salles de la Salle OMO (L18c) : ouverture d'une salle par projet, statut, arrêt, et 403 des faits d'une racine de la salle en
// mode Simple. Harnais du cockpit avec l'option `omo` (second faux opencode) et modules déclarés ; les ports voisins sont
// surchargés (`omoPrecheck` de L19b, `omoStop` de L23b, `omoControl` en espion), comme le plan le prévoit pour la vague 3.
//
// La porte `SALLE_OUVERTE` reste FAUSSE dans le dépôt : un module factice au nom réel « omoRoom » monte le VRAI service et les
// VRAIES routes sur un `c11` dont cette seule porte est ouverte. Tout le reste est réel — http.ts (authentification, garde
// anti-CSRF), le câblage 1.1, la base, les deux faux opencode. Un test garde le dépôt tel qu'il est livré : porte fermée, toutes
// les routes de la salle refusent.
//
// Chaque garde a son test qui échoue sans elle : mode Simple, confirmation absente, salle coupée, autonomie coupée, chemin
// (`..`, lien sortant, chemin absolu, hors du dossier de travail), projet non préparé, pré-contrôle refusé, racine étrangère à
// l'arrêt. Deux promesses sont vérifiées à chaque fois qu'elles peuvent l'être : AUCUNE requête au faux de l'instance principale,
// et AUCUNE valeur d'`auth.json` dans le statut.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { Cockpit11, Cockpit11Module } from "./contracts-11.ts";
import type { AppEnv } from "./env.ts";
import type { OmoControlPort, OmoPrecheckPort, OmoStopPort } from "./omo-contracts.ts";
import { createOmoRoom, normaliserProjet, OMO_PROJET_MAX_CARACTERES, type OmoRoomService } from "./omo-room.ts";
import { registerOmoRoutes } from "./routes-omo.ts";
import type { StopResult } from "./shared/cockpit-event-types.ts";
import { ecrireArret, ecrireBattement, OMO_DELAIS, OMO_FICHIERS_CONTROLE } from "./shared/omo-control-protocol.ts";
import type { OmoPrecheckProjectResult, OmoPreparedProjects, OmoStopCause, OmoSupervisorState } from "./shared/omo-types.ts";
import { phrasePrecontrole, phraseRefusActivation } from "./shared/omo-room-texts.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";

/** Valeur inventée, déposée dans `omo-auth/auth.json` : le statut ne doit JAMAIS la rendre (§4.12 l.784). */
const MARQUE_AUTH = "AUTH-DE-TEST-QUI-NE-DOIT-JAMAIS-SORTIR";

const ARRET: StopResult = { rootId: "", rejected: 0, aborted: [], unconfirmed: [], durationMs: 0 };

interface OptionsSalle {
  /** Porte SALLE_OUVERTE du `c11` remis aux routes et au service ; par défaut ouverte. */
  salleOuverte?: boolean;
  /** Mode de l'interface ; par défaut « avance » (la salle y est réservée). */
  mode?: "simple" | "avance";
  /** Variables du cockpit remplacées (le dossier de travail est posé par ce harnais). */
  env?: Partial<AppEnv>;
  /** Projets préparés écrits dans `omo-projets.json` ; `null` : aucun fichier déposé. */
  projets?: OmoPreparedProjects | null;
  /** Texte brut d'`omo-projets.json`, au lieu d'un objet (fichier illisible ou mal formé). */
  projetsTexte?: string;
  /** Verdict du pré-contrôle ; par défaut : conforme. */
  precheck?: (projet: string) => Awaited<ReturnType<OmoPrecheckPort["check"]>>;
  /** État publié par le superviseur (`state.json`), lu par le port `omoControl`. */
  etat?: OmoSupervisorState | null;
  /** Salle suspendue (D-2b-29). */
  suspendue?: boolean;
  /** Modules 1.1 réels installés en plus de la salle (par exemple « facts » pour les routes d'activité). */
  modules?: ReadonlyArray<"facts">;
  /** `omoStop.enCours` : arrêt ou relance à neuf en cours côté cockpit (relecture 2ter-vague-4) ; absent : aucun. */
  arretEnCours?: () => boolean;
}

interface Salle {
  h: CockpitHarness;
  workspace: string;
  control: string;
  auth: string;
  egress: string;
  projetsFichier: string;
  /** Ce que les ports voisins ont reçu. */
  appels: { precheck: string[]; stop: Array<{ rootId: string | null; cause: OmoStopCause }>; resume: number };
  /** Écrit (ou réécrit) `omo-projets.json`. */
  ecrireProjets(projets: OmoPreparedProjects | string): void;
}

const projetsDe = (...chemins: string[]): OmoPreparedProjects => ({
  version: 1,
  genereLe: "2026-09-19T10:00:00Z",
  projets: chemins.map((chemin) => ({ chemin, git: "dossier" as const })),
  gitProteges: chemins.map((chemin) => ({ chemin: `${chemin}/.git`, forme: "dossier" as const })),
});

const conforme = (projet: string): OmoPrecheckProjectResult => ({ projet, verdict: "conforme", raison: null, trouves: [] });

/**
 * Cockpit réel avec la salle branchée : second faux opencode (option `omo`), service et routes de L18c derrière une porte
 * `SALLE_OUVERTE` ouverte pour ce test seul, ports voisins en espions.
 */
async function salle(t: TestContext, options: OptionsSalle = {}): Promise<Salle> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omo-salle-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dossier = (nom: string) => {
    const complet = path.join(tmp, nom);
    fs.mkdirSync(complet, { recursive: true });
    return complet;
  };
  const workspace = dossier("workspace");
  const control = dossier("control");
  const auth = dossier("auth");
  const egress = dossier("egress");
  const projetsFichier = path.join(dossier("source"), "omo-projets.json");
  const ecrireProjets = (projets: OmoPreparedProjects | string) => {
    fs.writeFileSync(projetsFichier, typeof projets === "string" ? projets : `${JSON.stringify(projets)}\n`, "utf8");
  };
  if (options.projetsTexte !== undefined) ecrireProjets(options.projetsTexte);
  else if (options.projets !== null) ecrireProjets(options.projets ?? projetsDe("app"));

  const appels: Salle["appels"] = { precheck: [], stop: [], resume: 0 };
  const omoPrecheck: OmoPrecheckPort = {
    check: async (projet) => {
      appels.precheck.push(projet);
      return options.precheck ? options.precheck(projet) : { ok: true, resultat: conforme(projet) };
    },
    beforeStart: async (startId) => ({ ok: true, startId, resultats: [] }),
  };
  const omoStop: OmoStopPort = {
    run: async (rootId, cause) => {
      appels.stop.push({ rootId, cause });
      return { ...ARRET, rootId: rootId ?? "" };
    },
    relaunchAfterRequest: async () => undefined,
    ...(options.arretEnCours === undefined ? {} : { enCours: options.arretEnCours }),
  };
  const omoControl: OmoControlPort = {
    startHeartbeat: () => undefined,
    stopHeartbeat: () => undefined,
    requestStop: async () => undefined,
    writePrecheckOk: async () => undefined,
    writeGuardState: async () => undefined,
    publishAuth: async () => undefined,
    readState: async () => options.etat ?? null,
    suspend: () => undefined,
    resume: () => {
      appels.resume++;
    },
    suspended: () => options.suspendue === true,
  };

  // Module factice au nom réel : le VRAI service et les VRAIES routes, sur un c11 dont la seule porte SALLE_OUVERTE est ouverte.
  // `ports` est le même objet que celui de c11 : les surcharges posées après l'installation restent vues par le service.
  const moduleSalle: Cockpit11Module = {
    name: "omoRoom",
    install(reg, c11) {
      const ouvert: Cockpit11 = { ...c11, salleOuverte: options.salleOuverte ?? true };
      ouvert.ports.omoRoom = createOmoRoom({
        db: c11.db,
        sessions: c11.sessions,
        log: c11.log,
        env: c11.env,
        workspace,
        controlDir: control,
        authDir: auth,
        projectsFile: projetsFichier,
        egressJournal: egress,
        ports: () => c11.ports,
        instance: () => c11.instances?.omo ?? null,
        salleOuverte: () => ouvert.salleOuverte,
      });
      reg.routes("omo", (app) => registerOmoRoutes(app, ouvert), { instances: ["omo"] });
    },
  };

  const h = await startCockpit(t, {
    omo: true,
    modules: [...(options.modules ?? []), moduleSalle],
    ports: { omoPrecheck, omoStop, omoControl },
    settings: { ui: { mode: options.mode ?? "avance" } },
    env: { workspaceDir: workspace, ...options.env },
  });
  return { h, workspace, control, auth, egress, projetsFichier, appels, ecrireProjets };
}

/** Crée le dossier d'un projet dans le dossier de travail. */
function creerProjet(workspace: string, nom: string, avecGit = true): string {
  const complet = path.join(workspace, ...nom.split("/"));
  fs.mkdirSync(complet, { recursive: true });
  if (avecGit) fs.mkdirSync(path.join(complet, ".git"), { recursive: true });
  return complet;
}

const ouvrir = (s: Salle, projet: unknown, entetes: Record<string, string> = s.h.headers.confirmed) =>
  s.h.call("POST", "/api/omo/rooms", { headers: entetes, body: { projet } });

const corps = <T>(res: { json<U>(): U }) => res.json<T>();

/** Requêtes reçues par le faux de l'instance PRINCIPALE depuis le repère, sous forme « MÉTHODE /chemin ». */
const requetesPrincipales = (h: CockpitHarness, depuis: number) => h.fake.requests.slice(depuis).map((r) => `${r.method} ${r.pathname}`);

/** Lignes de `omo_rooms` (recopiées : node:sqlite rend des objets sans prototype). */
const lignesRooms = (h: CockpitHarness) =>
  (h.db.prepare("SELECT root_id, projet FROM omo_rooms ORDER BY root_id").all() as Array<{ root_id: string; projet: string }>).map((ligne) => ({
    root_id: ligne.root_id,
    projet: ligne.projet,
  }));

// --- Ouverture d'une salle (§4.14.1, §3.9 l.340) ----------------------------------------------------------------------------

describe("L18c : ouverture d'une salle par projet", () => {
  it("projet préparé et conforme : racine créée sur le faux de la SALLE, ligne omo_rooms, sessions.instance = omo, zéro requête au faux principal", async (t: TestContext) => {
    const s = await salle(t);
    creerProjet(s.workspace, "app");
    const repere = s.h.fake.requests.length;

    const res = await ouvrir(s, "app");
    assert.equal(res.status, 200, res.body);
    const { rootId, projet } = corps<{ rootId: string; projet: string }>(res);
    assert.equal(projet, "app");

    // La racine existe sur le faux de la salle, et sur lui seul.
    assert.ok(s.h.omo, "option omo");
    const creations = s.h.omo.fake.requests.filter((r) => r.method === "POST" && r.pathname === "/session");
    assert.equal(creations.length, 1);
    assert.deepEqual(creations[0]?.body, { title: "app" }, "titre seul");
    assert.deepEqual(requetesPrincipales(s.h, repere), [], "aucune requête à l'instance principale");
    s.h.assertNoGlobalRestart();

    assert.deepEqual(lignesRooms(s.h), [{ root_id: rootId, projet: "app" }]);
    assert.equal(s.h.sessions.get(rootId)?.instance, "omo");
    assert.deepEqual(s.h.cockpit.c11.ports.omoRoom.openProjects(), ["app"]);
    assert.equal(s.h.cockpit.c11.ports.omoRoom.isRoomRoot(rootId), true);
    assert.deepEqual(s.appels.precheck, ["app"]);
  });

  it("T-L18-g : un projet préparé SANS historique git est accepté ; un projet absent de la liste est refusé", async (t: TestContext) => {
    const s = await salle(t, {
      projets: { version: 1, genereLe: "2026-09-19T10:00:00Z", projets: [{ chemin: "sans-git", git: "absent" }], gitProteges: [] },
    });
    creerProjet(s.workspace, "sans-git", false);
    creerProjet(s.workspace, "autre");

    assert.equal((await ouvrir(s, "sans-git")).status, 200);
    const refuse = await ouvrir(s, "autre");
    assert.equal(refuse.status, 409, refuse.body);
    assert.equal(corps<{ error: string }>(refuse).error, "non-prepare");
  });

  it("T-L18-e : projet non préparé → 409 et la phrase « Projet non préparé pour la salle : relancez install.ps1 », sans aucun pré-contrôle", async (t: TestContext) => {
    const s = await salle(t);
    creerProjet(s.workspace, "nouveau");
    const res = await ouvrir(s, "nouveau");
    assert.equal(res.status, 409, res.body);
    assert.deepEqual(corps<{ error: string; message: string }>(res), { error: "non-prepare", message: phrasePrecontrole("non-prepare") });
    assert.match(corps<{ message: string }>(res).message, /relancez `install\.ps1`/);
    // Le pré-contrôle n'est pas consulté : la liste des projets préparés passe avant (fiche L18c, étapes 4 puis 5).
    assert.deepEqual(s.appels.precheck, []);
    assert.deepEqual(lignesRooms(s.h), []);
  });

  it("T-L18-e (suite) : liste absente, illisible ou mal formée → AUCUN projet n'est préparé (fermé en cas de doute)", async (t: TestContext) => {
    for (const cas of ["absente", "mal-formee", "pas-un-objet"] as const) {
      await t.test(cas, async (t2: TestContext) => {
        const s = await salle(t2, {
          ...(cas === "absente" ? { projets: null } : {}),
          ...(cas === "mal-formee" ? { projetsTexte: "{ pas du JSON" } : {}),
          ...(cas === "pas-un-objet" ? { projetsTexte: JSON.stringify({ version: 2, projets: [] }) } : {}),
        });
        creerProjet(s.workspace, "app");
        const res = await ouvrir(s, "app");
        assert.equal(res.status, 409, res.body);
        assert.equal(corps<{ error: string }>(res).error, "non-prepare");
      });
    }
  });

  it("T-L18-f : `..`, chemin absolu, lien sortant et chemin hors du dossier de travail → 400, sans rien ouvrir", async (t: TestContext) => {
    const s = await salle(t, { projets: projetsDe("app", "sortie", "vide") });
    creerProjet(s.workspace, "app");
    const dehors = path.join(path.dirname(s.workspace), "dehors");
    fs.mkdirSync(dehors, { recursive: true });
    let lienPose = true;
    try {
      fs.symlinkSync(dehors, path.join(s.workspace, "sortie"), "junction");
    } catch {
      // Lien impossible (droits) : les autres cas suffisent à garder la règle, celui-ci est simplement sauté.
      lienPose = false;
    }

    const cas: Array<[unknown, string]> = [
      ["../dehors", "hors-workspace"],
      ["app/../../dehors", "hors-workspace"],
      // « .. » est refusé même quand il RETOMBE dans le dossier de travail : sans cette règle, « app/../app » serait ouvert sous
      // un nom qui n'est pas celui du projet préparé, et la salle garderait ce nom-là.
      ["app/../app", "hors-workspace"],
      [path.join(dehors), "hors-workspace"],
      ["/etc", "hors-workspace"],
      ["", "hors-workspace"],
      [".", "hors-workspace"],
      ["x".repeat(OMO_PROJET_MAX_CARACTERES + 1), "hors-workspace"],
      [42, "hors-workspace"],
      [undefined, "hors-workspace"],
      ...(lienPose ? ([["sortie", "lien-symbolique"]] as Array<[unknown, string]>) : []),
    ];
    for (const [projet, code] of cas) {
      const res = await ouvrir(s, projet);
      assert.equal(res.status, 400, `${String(projet)} : ${res.body}`);
      assert.deepEqual(corps<{ error: string; message: string }>(res), { error: code, message: phrasePrecontrole(code as "hors-workspace") }, String(projet));
    }
    assert.deepEqual(s.appels.precheck, [], "aucun pré-contrôle sur un chemin refusé");
    assert.deepEqual(lignesRooms(s.h), []);
  });

  it("pré-contrôle refusé → 409 avec le code de la raison et la liste MASQUÉE des chemins trouvés ; le port qui refuse → 409 de son code", async (t: TestContext) => {
    const trouves = [".opencode/opencode.json", "../opencode.jsonc"];
    const s = await salle(t, {
      precheck: (projet) => ({ ok: true, resultat: { projet, verdict: "refuse", raison: "config-opencode", trouves } }),
    });
    creerProjet(s.workspace, "app");
    const res = await ouvrir(s, "app");
    assert.equal(res.status, 409, res.body);
    const recu = corps<{ error: string; message: string; precheck: OmoPrecheckProjectResult }>(res);
    assert.equal(recu.error, "config-opencode");
    assert.equal(recu.message, phrasePrecontrole("config-opencode"));
    assert.deepEqual(recu.precheck.trouves, trouves);
    assert.deepEqual(lignesRooms(s.h), []);

    const s2 = await salle(t, { precheck: () => ({ ok: false, code: "salle-suspendue" }) });
    creerProjet(s2.workspace, "app");
    const res2 = await ouvrir(s2, "app");
    assert.equal(res2.status, 409, res2.body);
    assert.deepEqual(corps<{ error: string; message: string }>(res2), { error: "salle-suspendue", message: phraseRefusActivation("salle-suspendue") });
  });

  it("T-L18-i : mode Simple ou confirmation absente → refus, avant toute lecture de disque et tout appel", async (t: TestContext) => {
    const simple = await salle(t, { mode: "simple" });
    creerProjet(simple.workspace, "app");
    const enSimple = await ouvrir(simple, "app");
    assert.equal(enSimple.status, 403, enSimple.body);
    assert.deepEqual(corps<{ error: string; message: string }>(enSimple), { error: "mode-avance", message: phraseRefusActivation("mode-avance") });

    const s = await salle(t);
    creerProjet(s.workspace, "app");
    const sansConfirmation = await ouvrir(s, "app", s.h.headers.mutating);
    assert.equal(sansConfirmation.status, 403, sansConfirmation.body);
    assert.deepEqual(corps<{ error: string; message: string }>(sansConfirmation), {
      error: "confirmation-requise",
      message: phraseRefusActivation("confirmation-requise"),
    });
    assert.deepEqual(s.appels.precheck, []);
    assert.deepEqual(lignesRooms(s.h), []);

    // La garde anti-CSRF de http.ts passe encore avant : sans son en-tête, rien n'atteint la salle.
    const sansCsrf = await s.h.call("POST", "/api/omo/rooms", { headers: s.h.headers.authed, body: { projet: "app" } });
    assert.equal(sansCsrf.status, 403);
    assert.equal(corps<{ error: string }>(sansCsrf).error, "csrf");
  });

  it("T-L18-h : salle coupée → 403 « salle-coupee » ; COCKPIT_AUTONOMY=off coupe aussi la salle (§9.4 n° 3)", async (t: TestContext) => {
    const coupee = await salle(t, { salleOuverte: false });
    creerProjet(coupee.workspace, "app");
    const res = await ouvrir(coupee, "app");
    assert.equal(res.status, 403, res.body);
    assert.deepEqual(corps<{ error: string; message: string }>(res), { error: "salle-coupee", message: phraseRefusActivation("salle-coupee") });
    // Même une route inconnue : la garde du groupe couvre tout /api/omo/*, avant tout port.
    const inconnue = await coupee.h.call("GET", "/api/omo/inconnue", { headers: coupee.h.headers.authed });
    assert.equal(inconnue.status, 403);
    assert.deepEqual(coupee.appels.precheck, []);
    // Le SERVICE refuse de lui-même, sans la garde du groupe : c'est lui qui tient la règle, pas la seule route.
    const port = coupee.h.cockpit.c11.ports.omoRoom as OmoRoomService;
    assert.deepEqual(await port.open({ projet: "app" }, { mode: "avance", confirmed: true }), { ok: false, status: 403, code: "salle-coupee", precheck: null });
    assert.deepEqual(await port.stop("ses_1"), { ok: false, status: 403, code: "salle-coupee" });
    assert.deepEqual(await port.precheck("app"), { ok: false, status: 409, code: "salle-coupee" });
    assert.deepEqual(coupee.appels.precheck, []);

    const sansAutonomie = await salle(t, { env: { autonomy: false } });
    creerProjet(sansAutonomie.workspace, "app");
    const res2 = await ouvrir(sansAutonomie, "app");
    assert.equal(res2.status, 403, res2.body);
    assert.deepEqual(corps<{ error: string; message: string }>(res2), { error: "autonomie-coupee", message: phraseRefusActivation("autonomie-coupee") });
    // Le pré-contrôle par la route suit la même coupure (409, jamais un relevé).
    const precheckCoupe = await sansAutonomie.h.call("GET", "/api/omo/precheck?projet=app", { headers: sansAutonomie.h.headers.authed });
    assert.equal(precheckCoupe.status, 409, precheckCoupe.body);
    assert.deepEqual(corps<{ error: string; message: string }>(precheckCoupe), {
      error: "autonomie-coupee",
      message: phraseRefusActivation("autonomie-coupee"),
    });
    assert.deepEqual(sansAutonomie.appels.precheck, []);
    assert.deepEqual(lignesRooms(sansAutonomie.h), []);
  });

  it("D-2b-29 : la réouverture confirmée d'une salle suspendue lève la suspension ; un refus ne la lève jamais", async (t: TestContext) => {
    const s = await salle(t, { suspendue: true });
    creerProjet(s.workspace, "app");
    assert.equal((await ouvrir(s, "inconnu")).status, 409);
    assert.equal((await ouvrir(s, "../dehors")).status, 400);
    assert.equal(s.appels.resume, 0, "aucun refus ne lève la suspension");

    assert.equal((await ouvrir(s, "app")).status, 200);
    assert.equal(s.appels.resume, 1);
  });

  it("corps invalide ou trop long : refusé sans atteindre le service", async (t: TestContext) => {
    const s = await salle(t);
    const malForme = await s.h.call("POST", "/api/omo/rooms", { headers: s.h.headers.confirmed, body: "{ pas du JSON" });
    assert.equal(malForme.status, 400, malForme.body);
    assert.equal(corps<{ error: string }>(malForme).error, "invalid");
    const tropLong = await s.h.call("POST", "/api/omo/rooms", { headers: s.h.headers.confirmed, body: { projet: "a".repeat(8192) } });
    assert.equal(tropLong.status, 413, tropLong.body);
    assert.deepEqual(s.appels.precheck, []);
  });
});

// --- Arrêt d'une salle (D-2b-30) ----------------------------------------------------------------------------------------------

describe("L18c : arrêt d'une salle", () => {
  it("racine de la salle → omoStop.run(rootId, « vous ») ; aucune requête au faux principal ; les deux modes", async (t: TestContext) => {
    for (const mode of ["avance", "simple"] as const) {
      await t.test(`mode ${mode}`, async (t2: TestContext) => {
        const s = await salle(t2, { mode: "avance" });
        creerProjet(s.workspace, "app");
        const { rootId } = corps<{ rootId: string }>(await ouvrir(s, "app"));
        if (mode === "simple") s.h.settings.update({ ui: { mode: "simple" } });

        const repere = s.h.fake.requests.length;
        const res = await s.h.call("POST", `/api/omo/rooms/${rootId}/stop`, { headers: s.h.headers.mutating });
        assert.equal(res.status, 200, res.body);
        assert.deepEqual(s.appels.stop, [{ rootId, cause: "vous" }]);
        assert.deepEqual(requetesPrincipales(s.h, repere), [], "aucune requête à l'instance principale");
        s.h.assertNoGlobalRestart();
      });
    }
  });

  it("racine de l'instance principale ou inconnue → 404, sans aucun appel ; identifiant invalide → 400", async (t: TestContext) => {
    const s = await salle(t, { modules: ["facts"] });
    const principale = await s.h.deps.client.request<{ id: string }>("POST", "/session", { body: { title: "Principale" } });
    s.h.sessions.upsert({ ...principale, projectID: "global", directory: s.workspace, time: { created: 1, updated: 1 } } as never);

    const repere = s.h.fake.requests.length;
    for (const rootId of [principale.id, "ses_inconnue"]) {
      const res = await s.h.call("POST", `/api/omo/rooms/${rootId}/stop`, { headers: s.h.headers.mutating });
      assert.equal(res.status, 404, res.body);
      assert.deepEqual(corps<{ error: string; message: string }>(res), { error: "racine-hors-salle", message: phraseRefusActivation("racine-hors-salle") });
    }
    assert.deepEqual(s.appels.stop, [], "aucun arrêt demandé");
    assert.deepEqual(requetesPrincipales(s.h, repere), [], "aucune requête à l'instance principale");

    const invalide = await s.h.call("POST", "/api/omo/rooms/pas%20un%20identifiant/stop", { headers: s.h.headers.mutating });
    assert.equal(invalide.status, 400, invalide.body);
  });

  it("salle coupée → 403, même pour une racine connue de la salle", async (t: TestContext) => {
    const s = await salle(t, { env: { autonomy: false } });
    s.h.db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, ?, ?)").run("ses_salle", "app", 1);
    const res = await s.h.call("POST", "/api/omo/rooms/ses_salle/stop", { headers: s.h.headers.mutating });
    assert.equal(res.status, 403, res.body);
    assert.equal(corps<{ error: string }>(res).error, "autonomie-coupee");
    assert.deepEqual(s.appels.stop, []);
  });

  it("sans en-tête anti-CSRF : refusé par http.ts, avant la salle", async (t: TestContext) => {
    const s = await salle(t);
    s.h.db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, ?, ?)").run("ses_salle", "app", 1);
    const res = await s.h.call("POST", "/api/omo/rooms/ses_salle/stop", { headers: s.h.headers.authed });
    assert.equal(res.status, 403, res.body);
    assert.equal(corps<{ error: string }>(res).error, "csrf");
    assert.deepEqual(s.appels.stop, []);
  });
});

// --- Statut et pré-contrôle (§4.12 l.784, §3.15.2) ------------------------------------------------------------------------------

const ETAT: OmoSupervisorState = {
  startId: "11111111-2222-3333-4444-555555555555",
  phase: "opencode-lance",
  imageId: "sha256:abcdef",
  manifestSha256: "0".repeat(64),
  manifesteReference: "ok",
  validation: "ok",
  dossiersConfig: [],
  projets: [{ chemin: "app", gitLectureSeule: true }],
  workspaceGit: { verifieLe: 1, limiteAtteinte: false, nonProteges: [] },
  startedAt: 1,
};

describe("L18c : statut de la salle", () => {
  it("aucun secret : la présence d'auth.json est dite, jamais son contenu ; image, projets, liste blanche et état sont rendus", async (t: TestContext) => {
    const s = await salle(t, { etat: ETAT, projets: projetsDe("app", "sans-etat") });
    fs.writeFileSync(path.join(s.auth, "auth.json"), JSON.stringify({ "github-copilot": { jeton: MARQUE_AUTH } }), "utf8");

    const res = await s.h.call("GET", "/api/omo/status", { headers: s.h.headers.authed });
    assert.equal(res.status, 200, res.body);
    assert.ok(!res.body.includes(MARQUE_AUTH), "aucune valeur d'auth.json dans le statut");
    const statut = corps<{
      interrupteurs: { omo: boolean; autonomie: boolean; salleOuverte: boolean };
      image: { chargee: boolean; id: string | null; manifesteSha256: string | null; version: string | null };
      authSalle: { presente: boolean };
      projetsPrepares: Array<{ chemin: string; git: string }>;
      listeBlanche: string[];
      etatSalle: string;
      workspaceGit: unknown;
      sortiesRefusees24h: unknown[];
      battement: { actif: boolean; ageMs: number | null };
    }>(res);
    assert.deepEqual(statut.authSalle, { presente: true });
    assert.deepEqual(statut.interrupteurs, { omo: true, autonomie: true, salleOuverte: true });
    assert.deepEqual(statut.image, { chargee: true, id: "sha256:abcdef", manifesteSha256: "0".repeat(64), version: "4.19.4", auditeLe: null } as never);
    assert.deepEqual(statut.projetsPrepares, [
      { chemin: "app", git: "lecture-seule" },
      { chemin: "sans-etat", git: "inconnu" },
    ]);
    assert.deepEqual(statut.listeBlanche, ["api.githubcopilot.com"]);
    assert.equal(statut.etatSalle, "prete");
    assert.deepEqual(statut.workspaceGit, ETAT.workspaceGit);
    assert.deepEqual(statut.sortiesRefusees24h, []);
    assert.deepEqual(statut.battement, { actif: false, ageMs: null });
  });

  it("sans auth.json : présence fausse ; état du superviseur inconnu → salle arrêtée ; suspendue → suspendue", async (t: TestContext) => {
    const s = await salle(t);
    const statut = corps<{ authSalle: { presente: boolean }; etatSalle: string; image: { chargee: boolean } }>(
      await s.h.call("GET", "/api/omo/status", { headers: s.h.headers.authed }),
    );
    assert.deepEqual(statut.authSalle, { presente: false });
    assert.equal(statut.etatSalle, "arretee");
    assert.equal(statut.image.chargee, false);

    const suspendue = await salle(t, { suspendue: true, etat: ETAT });
    const vue = corps<{ etatSalle: string }>(await suspendue.h.call("GET", "/api/omo/status", { headers: suspendue.h.headers.authed }));
    assert.equal(vue.etatSalle, "suspendue");
  });

  it("relecture 2ter-vague-4 : relance à neuf décidée, superviseur pas encore passé (stop-request de CE démarrage, ou arrêt en cours) → « en-relance », jamais « prête » ; un stop-request déjà honoré ne change rien", async (t: TestContext) => {
    let enCours = false;
    const s = await salle(t, { etat: ETAT, arretEnCours: () => enCours });
    const etatSalle = async () => corps<{ etatSalle: string }>(await s.h.call("GET", "/api/omo/status", { headers: s.h.headers.authed })).etatSalle;
    const arret = path.join(s.control, OMO_FICHIERS_CONTROLE.arret);
    assert.equal(await etatSalle(), "prete");
    fs.writeFileSync(arret, ecrireArret(Date.now(), "fin-de-demande", "99999999-2222-3333-4444-555555555555"), "utf8");
    assert.equal(await etatSalle(), "prete", "stop-request d'un démarrage précédent : déjà honoré");
    fs.writeFileSync(arret, ecrireArret(Date.now(), "fin-de-demande", ETAT.startId), "utf8");
    assert.equal(await etatSalle(), "en-relance", "stop-request de CE démarrage");
    fs.rmSync(arret);
    assert.equal(await etatSalle(), "prete");
    enCours = true;
    assert.equal(await etatSalle(), "en-relance", "arrêt en cours, stop-request pas encore écrit");
  });

  it("dernier démarrage : la ligne omo_room_starts liée à un start_id, avec ses résultats masqués", async (t: TestContext) => {
    const s = await salle(t, { etat: ETAT });
    const precheck = JSON.stringify([conforme("app"), { projet: "b", verdict: "refuse", raison: "inconnue-du-contrat", trouves: [".opencode"] }]);
    s.h.db
      .prepare("INSERT INTO omo_room_starts (started_at, image_id, manifest_sha256, precheck, cause, start_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(1_700_000_000_000, "sha256:abcdef", "0".repeat(64), precheck, "demarrage", ETAT.startId);
    const statut = corps<{ dernierDemarrage: { startId: string; at: number; precheck: OmoPrecheckProjectResult[] } }>(
      await s.h.call("GET", "/api/omo/status", { headers: s.h.headers.authed }),
    );
    assert.equal(statut.dernierDemarrage.startId, ETAT.startId);
    assert.equal(statut.dernierDemarrage.at, 1_700_000_000_000);
    assert.deepEqual(statut.dernierDemarrage.precheck, [
      conforme("app"),
      // Raison hors du contrat : le lecteur ne l'invente pas, il la met à null.
      { projet: "b", verdict: "refuse", raison: null, trouves: [".opencode"] },
    ]);
  });

  it("battement : frais → actif avec son âge ; périmé ou illisible → inactif ; phase « arret » → salle en relance", async (t: TestContext) => {
    const s = await salle(t, { etat: { ...ETAT, phase: "arret" } });
    const battement = path.join(s.control, OMO_FICHIERS_CONTROLE.battement);
    const lire = async () =>
      corps<{ battement: { actif: boolean; ageMs: number | null }; etatSalle: string }>(
        await s.h.call("GET", "/api/omo/status", { headers: s.h.headers.authed }),
      );

    fs.writeFileSync(battement, ecrireBattement(Date.now()), "utf8");
    const frais = await lire();
    assert.equal(frais.battement.actif, true);
    assert.ok((frais.battement.ageMs ?? -1) >= 0 && (frais.battement.ageMs ?? Infinity) < OMO_DELAIS.perimeS * 1000);
    assert.equal(frais.etatSalle, "en-relance");

    fs.writeFileSync(battement, ecrireBattement(Date.now() - (OMO_DELAIS.perimeS + 10) * 1000), "utf8");
    assert.equal((await lire()).battement.actif, false);

    fs.writeFileSync(battement, "{ pas du JSON", "utf8");
    assert.deepEqual((await lire()).battement, { actif: false, ageMs: null });
  });

  it("GET /api/omo/precheck : même validation de chemin (400), verdict rendu tel quel, mode Avancé seulement", async (t: TestContext) => {
    const s = await salle(t, { precheck: (projet) => ({ ok: true, resultat: { projet, verdict: "refuse", raison: "fichier-cle", trouves: ["cle.pem"] } }) });
    creerProjet(s.workspace, "app");
    const res = await s.h.call("GET", "/api/omo/precheck?projet=app", { headers: s.h.headers.authed });
    assert.equal(res.status, 200, res.body);
    assert.deepEqual(corps<OmoPrecheckProjectResult>(res), { projet: "app", verdict: "refuse", raison: "fichier-cle", trouves: ["cle.pem"] });

    const hors = await s.h.call("GET", "/api/omo/precheck?projet=../dehors", { headers: s.h.headers.authed });
    assert.equal(hors.status, 400, hors.body);
    assert.equal(corps<{ error: string }>(hors).error, "hors-workspace");

    s.h.settings.update({ ui: { mode: "simple" } });
    const enSimple = await s.h.call("GET", "/api/omo/precheck?projet=app", { headers: s.h.headers.authed });
    assert.equal(enSimple.status, 403, enSimple.body);
    assert.equal(corps<{ error: string }>(enSimple).error, "mode-avance");
  });
});

// --- Faits et activité d'une racine de la salle (décision A11, question Q7 (a)) --------------------------------------------------

describe("L18c : activité et faits d'une racine de la salle", () => {
  it("en mode Simple → 403 DÉFINITIF sur /activity et sur /facts ; en Avancé → servis ; une racine hors salle ne change pas", async (t: TestContext) => {
    const s = await salle(t, { modules: ["facts"] });
    creerProjet(s.workspace, "app");
    const { rootId } = corps<{ rootId: string }>(await ouvrir(s, "app"));
    const principale = await s.h.deps.client.request<{ id: string }>("POST", "/session", { body: { title: "Principale" } });
    s.h.sessions.upsert({ ...principale, projectID: "global", directory: s.workspace, time: { created: 1, updated: 1 } } as never);

    for (const chemin of [`/api/conversations/${rootId}/activity`, `/api/conversations/${rootId}/facts?since=0`]) {
      assert.equal((await s.h.call("GET", chemin, { headers: s.h.headers.authed })).status, 200, `Avancé : ${chemin}`);
    }

    s.h.settings.update({ ui: { mode: "simple" } });
    for (const chemin of [`/api/conversations/${rootId}/activity`, `/api/conversations/${rootId}/facts?since=0`]) {
      const res = await s.h.call("GET", chemin, { headers: s.h.headers.authed });
      assert.equal(res.status, 403, `Simple : ${chemin} → ${res.body}`);
      assert.deepEqual(corps<{ error: string; message: string }>(res), { error: "mode-avance", message: phraseRefusActivation("mode-avance") });
    }
    // Hors de la salle, le mode Simple ne change rien : les deux routes répondent comme avant.
    for (const chemin of [`/api/conversations/${principale.id}/activity`, `/api/conversations/${principale.id}/facts?since=0`]) {
      assert.equal((await s.h.call("GET", chemin, { headers: s.h.headers.authed })).status, 200, `hors salle : ${chemin}`);
    }
    // Un identifiant invalide reste un 400 : la garde de la salle ne passe jamais devant la validation.
    assert.equal((await s.h.call("GET", "/api/conversations/pas%20valide/activity", { headers: s.h.headers.authed })).status, 400);
  });
});

// --- Le dépôt tel qu'il est livré ------------------------------------------------------------------------------------------------

describe("L18c : porte SALLE_OUVERTE du dépôt", () => {
  it("module réel, salle configurée : toutes les routes /api/omo/* refusent « salle-coupee », et aucune racine n'appartient à la salle", async (t: TestContext) => {
    const h = await startCockpit(t, { omo: true, modules: ["omoControl", "omoRoom"] });
    for (const [methode, chemin] of [
      ["POST", "/api/omo/rooms"],
      ["POST", "/api/omo/rooms/ses_1/stop"],
      ["GET", "/api/omo/status"],
      ["GET", "/api/omo/precheck?projet=app"],
    ] as Array<[string, string]>) {
      const res = await h.call(methode, chemin, { headers: h.headers.confirmed, ...(methode === "POST" ? { body: {} } : {}) });
      assert.equal(res.status, 403, `${methode} ${chemin} : ${res.body}`);
      assert.equal(res.json<{ error: string }>().error, "salle-coupee");
    }
    assert.equal(h.cockpit.c11.ports.omoRoom.isRoomRoot("ses_1"), false);
    assert.deepEqual(h.cockpit.c11.ports.omoRoom.openProjects(), []);
    h.assertNoGlobalRestart();
  });
});

// --- Normalisation des chemins ---------------------------------------------------------------------------------------------------

describe("L18c : normalisation d'un chemin de projet", () => {
  it("séparateurs, « ./ » et barres de fin sans effet ; le dossier de travail lui-même vaut « . »", () => {
    assert.equal(normaliserProjet("app"), "app");
    assert.equal(normaliserProjet("./app/"), "app");
    assert.equal(normaliserProjet("groupe\\app"), "groupe/app");
    assert.equal(normaliserProjet("groupe//app"), "groupe/app");
    assert.equal(normaliserProjet(""), ".");
    assert.equal(normaliserProjet("./"), ".");
  });
});
