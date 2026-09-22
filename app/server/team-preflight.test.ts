// Pré-lancement des équipes (L37p, plan d'exécution it4 fiche L37p, D-eq-17, D-eq-18, D-eq-19, décision A4 du 19/09).
//
// Ce que ces tests prouvent, sur le faux opencode et son journal COMPLET (`fake.requests`) :
// - « Rien n'a été envoyé ni facturé » (spéc. §6 l.1037, sortie §7.8 l.1189) : pour CHAQUE code de refus de `check`, ZÉRO
//   requête n'est reçue par le faux entre l'appel et sa réponse (toutes méthodes, tous chemins), y compris pour les codes qui
//   venaient autrefois d'une lecture (dossier-externe, profondeur-delegation, extension-configuree, ia-indisponible,
//   estimation-perimee, conversation-occupee) ;
// - « Aucune IA indisponible n'est proposée » (l.1050) : une IA absente du catalogue n'est ni proposée par `assistants`, ni
//   acceptée par `check` (409 ia-indisponible, sans repli) ;
// - l'instantané des lectures est borné (10 min, 32), lié à l'équipe, au dossier, à la racine et au mode, et n'apparaît dans
//   aucun journal ;
// - le texte du module lui-même : `check` et les contrôles qu'il appelle ne citent ni `lookup`, ni `client`, ni une fonction de
//   lecture (repères « Contrôles sans aucune requête »).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { EqContext, PreflightInput, RunPlan, TeamPreflightPort, TeamRow } from "./contracts-eq.ts";
import type { OcSession, RequestOptions } from "./opencode.ts";
import { assistantPermission, effectiveAgentRules, type Rule, type UiMode } from "./shared/assistant-rules.ts";
import type { Flow, TeamEstimateResponse, TeamRunBody } from "./shared/team-types.ts";
import { type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import { type FakeAgent, nativeAgents, type PermissionRule } from "./test-support/fake-opencode.ts";
import { canonicalAgentRules, createTeamPreflight, rulesSha256, SNAPSHOT_MAX, SNAPSHOT_TTL_MS } from "./team-preflight.ts";
import { createTeamStore } from "./team-store.ts";

const IA = "github-copilot/gpt-5-mini";
const ROOT = "ses_racine";
const T0 = 1_800_000_000_000;

const FLOW: Flow = {
  version: 1,
  blocs: [
    { type: "etape", id: "b1", etape: { id: "e1", titre: "Standards", assistant: "relire-script", niveau: null, taille: "M", consigne: "Relis.", recoit: "demande" } },
    { type: "etape", id: "b2", etape: { id: "e2", titre: "Sécurité", assistant: "relire-script", niveau: null, taille: "M", consigne: "Relis aussi.", recoit: "precedent" } },
  ],
};

const EQUIPE: TeamRow = {
  id: "relecture-script",
  titre: "Chaîne de relecture de script",
  description: "Deux étapes à la suite.",
  flow: JSON.stringify(FLOW),
  origine: "exemple",
  exemple_id: "relecture-script",
  exemple_version: 1,
  avance: 0,
  created_at: 1,
  updated_at: 1,
};

/** Règles effectives d'un assistant « Lecture seule », telles qu'opencode les rend (défauts, puis profil, puis ajout du test). */
const reglesLecture = (extra: Record<string, unknown> = {}): Rule[] => effectiveAgentRules(undefined, { ...assistantPermission("lecture", false, []), ...extra });

function agent(name: string, options: { mode?: FakeAgent["mode"]; hidden?: boolean; model?: string | null; permission?: Record<string, unknown> } = {}): FakeAgent {
  const model = options.model === undefined ? IA : options.model;
  const [providerID = "", modelID = ""] = model === null ? [] : [model.slice(0, model.indexOf("/")), model.slice(model.indexOf("/") + 1)];
  return {
    name,
    mode: options.mode ?? "primary",
    options: {},
    ...(options.hidden === true ? { hidden: true } : {}),
    ...(model === null ? {} : { model: { providerID, modelID } }),
    permission: reglesLecture(options.permission),
    steps: 40,
  };
}

/** Liste servie par GET /agent : agents natifs, l'assistant de relecture, un agent caché et un agent interne du cockpit. */
const agentsParDefaut = (extra: Record<string, unknown> = {}): FakeAgent[] => [
  ...nativeAgents(),
  agent("relire-script", { permission: extra }),
  agent("cache", { hidden: true }),
  agent("cockpit-classifier"),
];

interface Banc {
  h: CockpitHarness;
  eq: EqContext;
  preflight: TeamPreflightPort;
  directory: string;
  horloge: { valeur: number };
  corps(patch?: Partial<TeamRunBody>): TeamRunBody;
  entree(patch?: Partial<TeamRunBody>, options?: { mode?: UiMode; confirmed?: boolean }): PreflightInput;
  estimer(patch?: { directory?: string; rootId?: string | null }, mode?: UiMode): Promise<TeamEstimateResponse>;
  /** Exécute l'appel et échoue si le faux a reçu la moindre requête entre l'appel et sa réponse (A4). */
  sansRequete<T>(fn: () => Promise<T>): Promise<T>;
  racine(id?: string): string;
}

async function banc(
  t: TestContext,
  options: { settings?: Record<string, unknown>; agents?: FakeAgent[]; simpleOuvertes?: boolean; deps?: CockpitHarnessOptions["deps"] } = {},
): Promise<Banc> {
  const h = await startCockpit(t, {
    equipes: ["teamPreflight"],
    ...(options.settings ? { settings: options.settings } : {}),
    ...(options.deps ? { deps: options.deps } : {}),
  });
  const local = path.join(h.deps.env.workspaceDir, "projet");
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, "note.md"), "note");
  fs.mkdirSync(path.join(local, "sous-dossier"), { recursive: true });
  fs.mkdirSync(path.join(h.deps.env.workspaceDir, "dehors"), { recursive: true });
  fs.writeFileSync(path.join(h.deps.env.workspaceDir, "dehors", "secret.md"), "dehors");
  const directory = `${h.fake.directory}/projet`;
  h.fake.setAgents(options.agents ?? agentsParDefaut());
  h.db
    .prepare("INSERT INTO item_meta (kind, name, title, rights, task_size, origin, created_at, updated_at) VALUES ('agents', ?, ?, 'lecture', 'M', 'catalogue', 0, 0)")
    .run("relire-script", "Relire un script");
  const horloge = { valeur: T0 };
  const base = h.cockpit.equipes.eq;
  const eq: EqContext = options.simpleOuvertes === undefined ? base : { ...base, simpleOuvertes: options.simpleOuvertes };
  const preflight = createTeamPreflight(eq, { now: () => horloge.valeur });

  const corps = (patch: Partial<TeamRunBody> = {}): TeamRunBody => ({
    directory,
    rootId: null,
    demande: "Relis le script de sauvegarde.",
    fichiers: [],
    agentConversation: "build",
    estimateSha256: "",
    confirmations: {},
    ...patch,
  });
  return {
    h,
    eq,
    preflight,
    directory,
    horloge,
    corps,
    entree: (patch = {}, opts = {}) => ({ team: EQUIPE, body: corps(patch), mode: opts.mode ?? "avance", confirmed: opts.confirmed ?? false }),
    async estimer(patch = {}, mode: UiMode = "avance") {
      const res = await preflight.estimate(EQUIPE, { directory, rootId: null, ...patch }, mode);
      assert.equal(res.ok, true, JSON.stringify(res));
      return (res as { ok: true; response: TeamEstimateResponse }).response;
    },
    async sansRequete(fn) {
      const avant = h.fake.requests.length;
      const out = await fn();
      const apres = h.fake.requests.slice(avant).map((r) => `${r.method} ${r.pathname}`);
      assert.deepEqual(apres, [], `requêtes émises pendant un refus : ${apres.join(", ")}`);
      return out;
    },
    racine(id = ROOT) {
      h.sessions.upsert({ id, title: "Conversation", directory, time: { created: 1, updated: 1 } } as OcSession);
      return id;
    },
  };
}

/** Refus rendu par `check`, sous la forme comparée par les tests. */
async function refusDe(b: Banc, input: PreflightInput): Promise<{ status: number; code: string; details?: Record<string, unknown> }> {
  const out = await b.sansRequete(() => b.preflight.check(input));
  assert.equal(out.ok, false, `refus attendu, plan rendu : ${JSON.stringify(out)}`);
  const refus = out as { ok: false; status: number; code: string; details?: Record<string, unknown> };
  return refus.details === undefined ? { status: refus.status, code: refus.code } : { status: refus.status, code: refus.code, details: refus.details };
}

/** Corps prêt à être accepté : estimation faite sur LE MÊME dossier, la même racine et le même mode (B0), empreinte reprise. */
async function corpsEstime(b: Banc, patch: Partial<TeamRunBody> = {}, mode: UiMode = "avance"): Promise<TeamRunBody> {
  const estimation = await b.estimer({ rootId: patch.rootId ?? null, ...(patch.directory === undefined ? {} : { directory: patch.directory }) }, mode);
  return b.corps({ ...patch, estimateSha256: estimation.estimateSha256 });
}

// --- Forme canonique et empreintes (P11, report MX-EQ) ----------------------------------------------------------------------

describe("L37p : forme canonique des règles et empreintes P11", () => {
  it("chaque suite de règles consécutives de même permission et même action est triée ; l'ordre des suites ne bouge pas", () => {
    const suite = (patterns: string[], permission: string, action: Rule["action"]): Rule[] => patterns.map((pattern) => ({ permission, pattern, action }));
    const a: Rule[] = [...suite(["/b/*", "/a/*", "/c/*"], "external_directory", "allow"), ...suite(["*"], "external_directory", "ask"), ...suite(["*.env"], "read", "ask")];
    const b: Rule[] = [...suite(["/c/*", "/b/*", "/a/*"], "external_directory", "allow"), ...suite(["*"], "external_directory", "ask"), ...suite(["*.env"], "read", "ask")];
    assert.deepEqual(canonicalAgentRules(a), canonicalAgentRules(b), "l'ordre de la liste blanche d'opencode ne change plus l'empreinte");
    assert.equal(rulesSha256(a), rulesSha256(b));
    // La décision, elle, dépend de l'ordre des suites : deux ordres différents restent deux empreintes différentes.
    const inverse: Rule[] = [...suite(["*"], "external_directory", "ask"), ...suite(["/a/*", "/b/*", "/c/*"], "external_directory", "allow"), ...suite(["*.env"], "read", "ask")];
    assert.notEqual(rulesSha256(a), rulesSha256(inverse));
    assert.deepEqual(canonicalAgentRules([]), []);
    assert.match(rulesSha256(a), /^[0-9a-f]{64}$/);
  });
});

// --- Assistants (P1) ---------------------------------------------------------------------------------------------------------

describe("L37p : assistants d'un dossier", () => {
  it("StepAssistant depuis GET /agent et item_meta ; une IA absente du catalogue rend l'assistant non proposable (P1)", async (t) => {
    const b = await banc(t, { agents: [...agentsParDefaut(), agent("relire-sql", { model: "github-copilot/ia-disparue" })] });
    assert.notEqual(b.eq.ports.preflight.check, undefined, "le module pose le port");
    const carte = await b.preflight.assistants(b.directory);

    const relire = carte.get("relire-script");
    assert.equal(relire?.title, "Relire un script", "titre lu dans item_meta");
    assert.equal(relire?.rights, "lecture");
    assert.equal(relire?.origin, "catalogue");
    assert.equal(relire?.taille, "M");
    assert.equal(relire?.model, IA);
    assert.equal(relire?.steps, 40);
    assert.equal(relire?.available, true);
    assert.ok((relire?.rules.length ?? 0) > 0, "règles effectives lues");

    assert.equal(carte.get("build")?.origin, "natif");
    assert.equal(carte.get("build")?.rights, "integre");
    assert.equal(carte.get("cockpit-classifier")?.origin, "interne");
    assert.equal(carte.get("cache")?.hidden, true);
    assert.equal(carte.get("general")?.mode, "subagent");
    // « Aucune IA indisponible n'est proposée » (l.1050) : l'assistant dont l'IA propre a disparu du catalogue n'est plus proposable.
    assert.equal(carte.get("relire-sql")?.available, false);
  });
});

// --- Estimation : lectures, instantané, blocage -------------------------------------------------------------------------------

describe("L37p : estimation (seul point qui lit opencode, A4)", () => {
  it("lectures attendues, empreinte, plafond et validité ; le blocage annonce le premier refus prévisible", async (t) => {
    const b = await banc(t);
    const avant = b.h.fake.requests.length;
    const estimation = await b.estimer({ rootId: b.racine() });
    const lues = b.h.fake.requests.slice(avant).map((r) => `${r.method} ${r.pathname}`);
    assert.deepEqual(lues.toSorted(), ["GET /agent", "GET /command", "GET /global/config", "GET /session/status"], lues.join(", "));
    assert.match(estimation.estimateSha256, /^[0-9a-f]{64}$/);
    assert.equal(estimation.estimate.etapesFacturees, 2);
    assert.equal(estimation.plafond, estimation.estimate.maximum, "le plafond EST l'estimation haute");
    assert.equal(estimation.expireA, T0 + SNAPSHOT_TTL_MS);
    assert.equal(estimation.blocage, null);
    assert.equal(estimation.deja, null);
    assert.deepEqual(estimation.problems, []);

    // Une extension déclarée : l'estimation répond 200 (une estimation n'est pas un refus) et annonce le blocage.
    b.h.fake.globalConfig = { ...b.h.fake.globalConfig, mcp: { outil: { type: "local", enabled: false } } };
    b.h.deps.lookup.invalidate();
    const bloquee = await b.estimer({ rootId: ROOT });
    assert.deepEqual(bloquee.blocage, { status: 409, code: "extension-configuree" });
  });

  it("lecture impossible : 502 opencode-injoignable, et AUCUN instantané n'est gardé", async (t) => {
    const b = await banc(t);
    await b.h.fake.close();
    const res = await b.preflight.estimate(EQUIPE, { directory: b.directory, rootId: null }, "avance");
    assert.deepEqual(res, { ok: false, status: 502, code: "opencode-injoignable" });
    // Rien n'a été gardé : tout lancement qui s'en réclamerait est renvoyé à une nouvelle estimation, sans requête.
    const refus = await refusDe(b, b.entree({ estimateSha256: "0".repeat(64) }));
    assert.deepEqual(refus, { status: 409, code: "estimation-perimee" });
  });
});

// --- Instantané : bornes et identité ------------------------------------------------------------------------------------------

describe("L37p : instantané de l'estimation (D-eq-17)", () => {
  it("expiré, autre équipe, autre dossier, autre racine ou autre mode → estimation-perimee, sans aucune requête", async (t) => {
    const b = await banc(t, { simpleOuvertes: true });
    const racine = b.racine();
    const estimation = await b.estimer({ rootId: racine });
    const sha = estimation.estimateSha256;

    // Même corps, même équipe : accepté (témoin).
    const ok = await b.sansRequete(() => b.preflight.check(b.entree({ rootId: racine, estimateSha256: sha })));
    assert.equal(ok.ok, true, JSON.stringify(ok));

    const autreEquipe: TeamRow = { ...EQUIPE, id: "autre-equipe" };
    assert.deepEqual(await refusDe(b, { team: autreEquipe, body: b.corps({ rootId: racine, estimateSha256: sha }), mode: "avance", confirmed: false }), {
      status: 409,
      code: "estimation-perimee",
    });
    assert.deepEqual(await refusDe(b, b.entree({ rootId: racine, estimateSha256: sha, directory: `${b.h.fake.directory}/autre` })), { status: 409, code: "estimation-perimee" });
    assert.deepEqual(await refusDe(b, b.entree({ rootId: null, estimateSha256: sha })), { status: 409, code: "estimation-perimee" });
    assert.deepEqual(await refusDe(b, b.entree({ rootId: racine, estimateSha256: sha }, { mode: "simple" })), { status: 409, code: "estimation-perimee" });

    // Horloge injectée : l'instantané expire au bout de 10 minutes, jamais avant.
    b.horloge.valeur = T0 + SNAPSHOT_TTL_MS - 1;
    assert.equal((await b.preflight.check(b.entree({ rootId: racine, estimateSha256: sha }))).ok, true);
    b.horloge.valeur = T0 + SNAPSHOT_TTL_MS;
    assert.deepEqual(await refusDe(b, b.entree({ rootId: racine, estimateSha256: sha })), { status: 409, code: "estimation-perimee" });
  });

  it("32 instantanés au plus : le 33e fait sortir le plus ancien", async (t) => {
    const b = await banc(t);
    // Un tarif différent par estimation : chaque empreinte est distincte, donc chaque instantané occupe une place.
    const tarif = (i: number) => b.h.settings.update({ pricing: { overrides: { [IA]: { rates: { input: i + 1, cachedInput: 0.3, cacheWrite: null, output: 20 } } } } });
    const shas: string[] = [];
    for (let i = 0; i < SNAPSHOT_MAX + 1; i++) {
      tarif(i);
      b.horloge.valeur = T0 + i;
      shas.push((await b.estimer()).estimateSha256);
    }
    assert.equal(new Set(shas).size, SNAPSHOT_MAX + 1, "33 empreintes distinctes");

    // Le plus ancien est sorti : son empreinte n'est plus connue, et aucune requête n'est émise pour le dire.
    tarif(0);
    assert.deepEqual(await refusDe(b, b.entree({ estimateSha256: shas[0] as string })), { status: 409, code: "estimation-perimee" });
    // Le dernier, lui, est toujours là.
    tarif(SNAPSHOT_MAX);
    const out = await b.sansRequete(() => b.preflight.check(b.entree({ estimateSha256: shas.at(-1) as string })));
    assert.equal(out.ok, true, JSON.stringify(out));
  });

  it("aucun texte d'instantané dans les journaux", async (t) => {
    const lignes: string[] = [];
    const espion = (message: string, fields?: Record<string, unknown>) => void lignes.push(`${message} ${JSON.stringify(fields ?? {})}`);
    const b = await banc(t, { deps: (base) => ({ log: { ...base.log, debug: espion, info: espion, warn: espion, error: espion } }) });
    const estimation = await b.estimer({ rootId: b.racine() });
    const out = await b.preflight.check(b.entree({ rootId: ROOT, estimateSha256: estimation.estimateSha256 }));
    assert.equal(out.ok, true, JSON.stringify(out));

    // Et quand les lectures échouent : la cause technique est journalisée, rien de l'instantané.
    await b.h.fake.close();
    b.h.deps.lookup.invalidate();
    await b.preflight.estimate(EQUIPE, { directory: b.directory, rootId: null }, "avance");
    await b.preflight.recheck((out as { ok: true; plan: RunPlan }).plan, ROOT);

    const journal = lignes.join("\n");
    assert.ok(journal.length > 0, "le journal n'est pas vide : l'espion voit bien les lignes");
    for (const interdit of [estimation.estimateSha256, "relire-script", b.directory, "Relire un script"]) {
      assert.equal(journal.includes(interdit), false, `journal : ${journal}`);
    }
  });
});

// --- Groupe A : corps, base, système de fichiers, réglages --------------------------------------------------------------------

describe("L37p : groupe A (aucune requête)", () => {
  it("A1 : dossier hors du workspace → forbidden-directory ; pièces jointes refusées (D-eq-18)", async (t) => {
    const b = await banc(t);
    const corps = await corpsEstime(b);
    assert.deepEqual(await refusDe(b, b.entree({ ...corps, directory: "/etc" })), { status: 403, code: "forbidden-directory" });

    // Témoin : une pièce jointe du dossier passe (le refus vient bien du contrôle, pas d'un refus général).
    const ok = await b.sansRequete(() => b.preflight.check(b.entree({ ...corps, fichiers: ["note.md"] })));
    assert.equal(ok.ok, true, JSON.stringify(ok));

    const lien = path.join(b.h.deps.env.workspaceDir, "projet", "lien");
    let lienPose = true;
    try {
      fs.symlinkSync(path.join(b.h.deps.env.workspaceDir, "dehors"), lien, "junction");
    } catch {
      lienPose = false;
    }
    const refuses = [
      ["hors du dossier", `${b.h.fake.directory}/dehors/secret.md`],
      ["remontée", "../dehors/secret.md"],
      ["inexistant", "absent.md"],
      ["dossier, pas fichier", "sous-dossier"],
      ["chemin trop long", `${"a".repeat(513)}.md`],
      ...(lienPose ? [["lien sortant", "lien/secret.md"]] : []),
    ] as const;
    for (const [nom, fichier] of refuses) {
      assert.deepEqual(await refusDe(b, b.entree({ ...corps, fichiers: [fichier] })), { status: 403, code: "fichier-refuse" }, nom);
    }
    const trop = Array.from({ length: 21 }, () => "note.md");
    assert.deepEqual(await refusDe(b, b.entree({ ...corps, fichiers: trop })), { status: 403, code: "fichier-refuse" }, "plus de 20 pièces jointes");
  });

  it("A2 : racine inconnue → not-found ; racine de la Salle OMO → instance-salle", async (t) => {
    const b = await banc(t);
    const corps = await corpsEstime(b);
    assert.deepEqual(await refusDe(b, b.entree({ ...corps, rootId: "ses_inconnue" })), { status: 404, code: "not-found" });

    const racine = b.racine("ses_omo");
    b.h.db.prepare("UPDATE sessions SET instance = 'omo' WHERE id = ?").run(racine);
    assert.deepEqual(await refusDe(b, b.entree({ ...corps, rootId: racine })), { status: 409, code: "instance-salle" });

    // Une session enfant n'est pas une racine.
    b.h.sessions.upsert({ id: "ses_enfant", parentID: ROOT, title: "Étape", directory: b.directory, time: { created: 1, updated: 1 } } as OcSession);
    assert.deepEqual(await refusDe(b, b.entree({ ...corps, rootId: "ses_enfant" })), { status: 404, code: "not-found" });
  });

  it("A3, A4 et A5 : Simple fermé, équipe déjà active dans la conversation, trop d'équipes actives", async (t) => {
    const b = await banc(t);
    const racine = b.racine();
    const corps = await corpsEstime(b, { rootId: racine });
    // A3 : la constante EQUIPES_SIMPLE_OUVERTES est fausse (décision U1).
    assert.deepEqual(await refusDe(b, b.entree(corps, { mode: "simple" })), { status: 403, code: "equipes-simple-fermees" });

    const store = createTeamStore({ db: b.h.db, now: () => T0 });
    store.teams.put({ id: EQUIPE.id, titre: EQUIPE.titre, description: "", flow: FLOW, origine: "exemple", avance: false });
    const lancement = (id: string, rootId: string) =>
      store.runs.create({
        id,
        teamId: EQUIPE.id,
        teamTitre: EQUIPE.titre,
        flow: FLOW,
        flowSha256: "flow",
        estimateSha256: null,
        modeUi: "avance",
        rootId,
        directory: b.directory,
        estimate: null,
        plafond: null,
      });
    lancement("run_1", racine);
    // A4 P4 : une seule équipe par conversation…
    assert.deepEqual(await refusDe(b, b.entree(corps)), { status: 409, code: "equipe-en-cours" });
    // … mais une relance du lancement lui-même ignore ce lancement.
    const relance = await refusDe(b, { ...b.entree(corps), relance: { runId: "run_1", restantes: ["e1", "e2"], depense: 0 } });
    assert.notEqual(relance.code, "equipe-en-cours");

    // A5 P5 : deux équipes actives au plus (réglage teams.maxActiveRuns).
    lancement("run_2", "ses_autre");
    const sansRacine = await corpsEstime(b);
    assert.deepEqual(await refusDe(b, b.entree(sansRacine)), { status: 409, code: "trop-d-equipes" });
  });

  it("A6 et A7 : dossier = racine du workspace (P9) et secret probable (P10)", async (t) => {
    const b = await banc(t);
    const racineWorkspace = b.h.fake.directory;
    const surLaRacine = await corpsEstime(b, { directory: racineWorkspace });
    assert.deepEqual(await refusDe(b, b.entree(surLaRacine)), { status: 409, code: "confirmation-workspace" });
    const confirme = await b.sansRequete(() => b.preflight.check(b.entree({ ...surLaRacine, confirmations: { workspace: true } })));
    assert.equal(confirme.ok, true, JSON.stringify(confirme));

    const corps = await corpsEstime(b);
    const avecSecret = { ...corps, demande: "Vérifie la connexion : password=motdepasse-secret." };
    assert.deepEqual(await refusDe(b, b.entree(avecSecret)), { status: 409, code: "secret-probable" });
    const accepte = await b.sansRequete(() => b.preflight.check(b.entree({ ...avecSecret, confirmations: { secret: true } })));
    assert.equal(accepte.ok, true, JSON.stringify(accepte));
  });

  it("ordre des contrôles : un corps qui cumule un refus A et un refus B rend le refus A", async (t) => {
    const b = await banc(t);
    // Dossier refusé (A1) ET aucune estimation (B0) : c'est le groupe A qui répond.
    assert.deepEqual(await refusDe(b, b.entree({ directory: "/etc", estimateSha256: "" })), { status: 403, code: "forbidden-directory" });
  });
});

// --- Groupe B : instantané, sans nouvelle lecture ------------------------------------------------------------------------------

describe("L37p : groupe B (aucune requête)", () => {
  it("B1 : assistant de la conversation interne, caché, sous-agent ou inconnu → 400 invalid", async (t) => {
    const b = await banc(t);
    const corps = await corpsEstime(b);
    for (const nom of ["cockpit-classifier", "compaction", "cache", "general", "inconnu"]) {
      assert.deepEqual(await refusDe(b, b.entree({ ...corps, agentConversation: nom })), {
        status: 400,
        code: "invalid",
        details: { champ: "agentConversation" },
      });
    }
    const ok = await b.sansRequete(() => b.preflight.check(b.entree({ ...corps, agentConversation: "relire-script" })));
    assert.equal(ok.ok, true, JSON.stringify(ok));
  });

  it("B2 : grammaire (422 equipe-invalide) et contenu du mode Avancé en Simple (403 mode-avance)", async (t) => {
    const b = await banc(t, { simpleOuvertes: true });
    const etape = (patch: Record<string, unknown>) => ({
      version: 1,
      blocs: [{ type: "etape", id: "b1", etape: { id: "e1", titre: "Standards", assistant: "relire-script", niveau: null, taille: "M", consigne: "Relis.", recoit: "demande", ...patch } }],
    });
    // Assistant absent du dossier : 422, la liste des problèmes accompagne le refus.
    const inconnue: TeamRow = { ...EQUIPE, flow: JSON.stringify(etape({ assistant: "absent" })) };
    const estimation = await b.preflight.estimate(inconnue, { directory: b.directory, rootId: null }, "avance");
    assert.equal(estimation.ok, true, JSON.stringify(estimation));
    const sha = (estimation as { ok: true; response: TeamEstimateResponse }).response.estimateSha256;
    const invalide = await refusDe(b, { team: inconnue, body: b.corps({ estimateSha256: sha }), mode: "avance", confirmed: false });
    assert.equal(invalide.status, 422);
    assert.equal(invalide.code, "equipe-invalide");
    assert.ok(Array.isArray(invalide.details?.problems));

    // Niveau choisi par l'équipe : contenu du mode Avancé, refusé en mode Simple.
    const avecNiveau: TeamRow = { ...EQUIPE, flow: JSON.stringify(etape({ niveau: "rapide" })) };
    const estimationSimple = await b.preflight.estimate(avecNiveau, { directory: b.directory, rootId: null }, "simple");
    assert.equal(estimationSimple.ok, true, JSON.stringify(estimationSimple));
    const shaSimple = (estimationSimple as { ok: true; response: TeamEstimateResponse }).response.estimateSha256;
    const refusSimple = await refusDe(b, { team: avecNiveau, body: b.corps({ estimateSha256: shaSimple }), mode: "simple", confirmed: false });
    assert.deepEqual(refusSimple, { status: 403, code: "mode-avance" });
  });

  it("B2 : une IA d'un fournisseur non autorisé → 403 fournisseur-refuse, sans repli", async (t) => {
    const b = await banc(t, { agents: [...nativeAgents(), agent("relire-script", { model: "autre/ia" }), agent("cache", { hidden: true })] });
    // L'IA est bien au catalogue (elle existe chez un autre fournisseur) : seul le fournisseur la refuse.
    b.h.fake.providers = [
      ...b.h.fake.providers,
      { id: "autre", name: "Autre fournisseur", models: { ia: { id: "ia", name: "IA maison", capabilities: { toolcall: true }, status: "active" } } },
    ];
    await b.h.deps.catalog.refresh();
    const corps = await corpsEstime(b);
    assert.deepEqual(await refusDe(b, b.entree(corps)), { status: 403, code: "fournisseur-refuse", details: { titre: "Standards" } });
  });

  it("B2 : une IA retirée du catalogue après l'estimation → 409 ia-indisponible, sans repli (P1)", async (t) => {
    const b = await banc(t);
    const corps = await corpsEstime(b);
    // L'IA disparaît du compte : GET /config/providers ne la sert plus, et le catalogue est relu (hors de l'appel mesuré).
    const provider = b.h.fake.providers[0];
    if (provider) provider.models = Object.fromEntries(Object.entries(provider.models).filter(([id]) => id !== "gpt-5-mini"));
    await b.h.deps.catalog.refresh();
    assert.deepEqual(await refusDe(b, b.entree(corps)), { status: 409, code: "ia-indisponible", details: { titre: "Standards" } });
  });

  it("B2 : un assistant qui ouvre un dossier extérieur sans demander → 409 dossier-externe (entrée générique)", async (t) => {
    // Entrée générique « * » à `allow`, mais l'échantillon de la carte d'identité (/tmp/x) laissé à « demande » : la grammaire
    // ne voit rien, le contrôle par étape refuse quand même (report MX-EQ : la décision se lit sur l'entrée générique).
    const b = await banc(t, { agents: agentsParDefaut({ external_directory: { "*": "allow", "/tmp/*": "ask" } }) });
    const corps = await corpsEstime(b);
    assert.deepEqual(await refusDe(b, b.entree(corps)), { status: 409, code: "dossier-externe", details: { titre: "Standards" } });

    // Une ouverture franche, elle, est déjà arrêtée par la grammaire (422), qui passe avant le contrôle par étape.
    const franche = await banc(t, { agents: agentsParDefaut({ external_directory: "allow" }) });
    const corpsFranc = await corpsEstime(franche);
    assert.equal((await refusDe(franche, franche.entree(corpsFranc))).code, "equipe-invalide");

    // Témoin (report MX-EQ) : la liste blanche qu'opencode ajoute toujours (sorties tronquées, /tmp/opencode/*, dossiers de
    // fiches) ne refuse personne — un contrôle « aucune règle allow » aurait refusé tous les assistants.
    const normal = await banc(t);
    const corpsNormal = await corpsEstime(normal);
    assert.ok(
      normal.h.fake.agents(normal.directory).some((a) => a.permission.some((r) => r.permission === "external_directory" && r.action === "allow")),
      "opencode ajoute bien une liste blanche external_directory",
    );
    const ok = await normal.sansRequete(() => normal.preflight.check(normal.entree(corpsNormal)));
    assert.equal(ok.ok, true, JSON.stringify(ok));
  });

  it("B3 : profondeur de délégation et extensions de la configuration (report MX-EQ, décision n° 14)", async (t) => {
    const b = await banc(t);
    b.h.fake.globalConfig = { ...b.h.fake.globalConfig, subagent_depth: 2 };
    const profond = await corpsEstime(b);
    assert.deepEqual(await refusDe(b, b.entree(profond)), { status: 409, code: "profondeur-delegation" });

    // subagent_depth absent = 1 (défaut d'opencode) : aucun refus.
    const { subagent_depth: _retire, ...sansProfondeur } = b.h.fake.globalConfig;
    b.h.fake.globalConfig = sansProfondeur;
    b.h.deps.lookup.invalidate();
    const corpsDefaut = await corpsEstime(b);
    const ok = await b.sansRequete(() => b.preflight.check(b.entree(corpsDefaut)));
    assert.equal(ok.ok, true, JSON.stringify(ok));

    // Un serveur MCP DÉSACTIVÉ compte comme configuré (refus prudent).
    b.h.fake.globalConfig = { ...b.h.fake.globalConfig, mcp: { outil: { type: "local", enabled: false } } };
    const mcp = await corpsEstime(b);
    assert.deepEqual(await refusDe(b, b.entree(mcp)), { status: 409, code: "extension-configuree" });

    const { mcp: _sansMcp, ...sansExtension } = b.h.fake.globalConfig;
    b.h.fake.globalConfig = { ...sansExtension, plugin: ["file:///home/node/.config/opencode/plugins/outil.js"] };
    const plugin = await corpsEstime(b);
    assert.deepEqual(await refusDe(b, b.entree(plugin)), { status: 409, code: "extension-configuree" });
  });

  it("B4 : un changement de prix périme l'empreinte de l'estimation", async (t) => {
    const b = await banc(t);
    const corps = await corpsEstime(b);
    b.h.settings.update({ pricing: { overrides: { [IA]: { rates: { input: 3, cachedInput: 0.3, cacheWrite: null, output: 20 } } } } });
    assert.deepEqual(await refusDe(b, b.entree(corps)), { status: 409, code: "estimation-perimee" });
  });

  it("B4 : confirmations une à une (workspace, secret, budget, plafond), puis l'en-tête pour le garde-fou P6", async (t) => {
    const b = await banc(t, { settings: { budget: { monthlyUsd: 0.01 } } });
    const corps = await corpsEstime(b, { directory: b.h.fake.directory, demande: "Compare avec password=motdepasse-secret." });
    const accords: TeamRunBody["confirmations"] = {};
    const attendus = [
      ["confirmation-workspace", "workspace"],
      ["secret-probable", "secret"],
      ["budget-insuffisant", "budget"],
      ["plafond-a-confirmer", "plafond"],
    ] as const;
    for (const [code, cle] of attendus) {
      const refus = await refusDe(b, b.entree({ ...corps, confirmations: { ...accords } }));
      assert.equal(refus.code, code, JSON.stringify(refus));
      accords[cle] = true;
    }
    const ok = await b.sansRequete(() => b.preflight.check(b.entree({ ...corps, confirmations: accords })));
    assert.equal(ok.ok, true, JSON.stringify(ok));
    // Le plafond par défaut vaut 5 % du budget mensuel (teams.maxCapUsd null).
    const estimation = await b.estimer({ directory: b.h.fake.directory });
    assert.deepEqual(estimation.confirmations.toSorted(), ["budget", "plafond", "workspace"]);

    // Mode Simple : le plafond trop haut est un refus (403), jamais une case à cocher.
    const simple = await banc(t, { settings: { budget: { monthlyUsd: 0.01 } }, simpleOuvertes: true });
    const corpsSimple = await corpsEstime(simple, {}, "simple");
    const refusSimple = await refusDe(simple, simple.entree({ ...corpsSimple, confirmations: { budget: true, plafond: true } }, { mode: "simple" }));
    assert.equal(refusSimple.code, "plafond-trop-haut");
    assert.equal(refusSimple.status, 403);
  });

  it("B4 : garde-fou budgétaire P6 confirmé par l'en-tête x-cockpit-confirm", async (t) => {
    const b = await banc(t, { settings: { budget: { guard: { fromPercent: 0, maxOutputPricePerM: 0.01 } } } });
    const corps = await corpsEstime(b);
    const refus = await refusDe(b, b.entree(corps));
    assert.equal(refus.code, "budget-guard");
    assert.equal(refus.status, 409);
    assert.equal(typeof refus.details?.message, "string", "le texte du garde-fou vient du serveur (§9.2)");
    const ok = await b.sansRequete(() => b.preflight.check(b.entree(corps, { confirmed: true })));
    assert.equal(ok.ok, true, JSON.stringify(ok));
  });

  it("B5 : conversation occupée à l'estimation → 409 conversation-occupee, rejoué sans nouvelle lecture", async (t) => {
    const b = await banc(t);
    const racine = b.racine();
    // Témoin : au repos, le lancement est accepté.
    const auRepos = await corpsEstime(b, { rootId: racine });
    assert.equal((await b.sansRequete(() => b.preflight.check(b.entree(auRepos)))).ok, true);

    // Le faux déclare une réponse en cours dans la conversation : l'estimation la lit et l'annonce.
    const original = b.h.deps.client.request.bind(b.h.deps.client);
    t.mock.method(b.h.deps.client, "request", ((method: string, pathname: string, opts?: RequestOptions) =>
      pathname === "/session/status" ? Promise.resolve({ [racine]: { type: "busy" } }) : original(method, pathname, opts)) as typeof b.h.deps.client.request);
    const estimation = await b.estimer({ rootId: racine });
    assert.deepEqual(estimation.blocage, { status: 409, code: "conversation-occupee" });
    // Le lancement rejoue l'instantané : même refus, sans redemander l'état à opencode.
    const corps = b.corps({ rootId: racine, estimateSha256: estimation.estimateSha256 });
    assert.deepEqual(await refusDe(b, b.entree(corps)), { status: 409, code: "conversation-occupee" });
  });
});

// --- Plan rendu ----------------------------------------------------------------------------------------------------------------

describe("L37p : plan rendu par un pré-lancement accepté", () => {
  it("instantané P11 par étape, et IA de la conversation dans l'ordre des trois sources", async (t) => {
    const b = await banc(t);
    const racine = b.racine();
    // L'assistant de la conversation a ici une IA propre : c'est la source 2 de `RunPlan.iaConversation`.
    const corps = await corpsEstime(b, { rootId: racine, agentConversation: "relire-script" });
    const out = await b.sansRequete(() => b.preflight.check(b.entree(corps)));
    assert.equal(out.ok, true, JSON.stringify(out));
    const plan = (out as { ok: true; plan: RunPlan }).plan;

    assert.equal(plan.etapes.length, 2);
    const etape = plan.etapes[0];
    assert.equal(etape?.stepId, "e1");
    assert.equal(etape?.assistant, "relire-script");
    assert.equal(etape?.model, IA);
    assert.equal(etape?.taille, "M");
    assert.equal(etape?.steps, 40);
    assert.match(etape?.rulesSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.match(etape?.floorSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(etape?.agentFileSha256, null, "assistant sans fichier lisible par le Studio du harnais");
    assert.ok((etape?.floor.length ?? 0) > 0 && (etape?.droits.length ?? 0) > 0);
    assert.equal(plan.rootId, racine);
    assert.equal(plan.directory, b.directory);
    assert.equal(plan.modeUi, "avance");
    assert.equal(plan.plafond, plan.estimate.maximum);
    assert.match(plan.flowSha256, /^[0-9a-f]{64}$/);
    // Ni racine ni session créée : le faux n'a vu aucun POST /session.
    assert.equal(b.h.fake.requests.some((r) => r.method === "POST" && r.pathname.startsWith("/session")), false);

    // Source 2 : l'IA propre de l'assistant de la conversation (aucun tour « message » enregistré).
    assert.deepEqual(plan.iaConversation, { model: IA, variant: null });

    // Source 1 : le dernier choix de la conversation l'emporte.
    b.h.ledger.recordChatTurn({
      session_id: racine,
      created_at: T0,
      kind: "message",
      agent: "build",
      command: null,
      tier: "equilibre",
      model: "github-copilot/claude-sonnet-5",
      variant: "high",
      runs: [],
    });
    const avecChoix = await b.sansRequete(() => b.preflight.check(b.entree(corps)));
    assert.deepEqual((avecChoix as { ok: true; plan: RunPlan }).plan.iaConversation, { model: "github-copilot/claude-sonnet-5", variant: "high" });

    // Source 3 : un assistant de conversation sans IA propre, sans tour enregistré → null (champ `model` omis à l'injection).
    const sansIa = await banc(t, { agents: [...nativeAgents(), agent("relire-script"), agent("conseiller", { model: null })] });
    const corpsSansIa = await corpsEstime(sansIa, { agentConversation: "conseiller" });
    const plan3 = await sansIa.sansRequete(() => sansIa.preflight.check(sansIa.entree(corpsSansIa)));
    assert.equal(plan3.ok, true, JSON.stringify(plan3));
    assert.equal((plan3 as { ok: true; plan: RunPlan }).plan.iaConversation, null);
  });
});

// --- Contrôle de fraîcheur ------------------------------------------------------------------------------------------------------

describe("L37p : contrôle de fraîcheur (recheck, après l'acceptation)", () => {
  const planDe = async (b: Banc, rootId: string): Promise<RunPlan> => {
    const corps = await corpsEstime(b, { rootId });
    const out = await b.preflight.check(b.entree(corps));
    assert.equal(out.ok, true, JSON.stringify(out));
    return (out as { ok: true; plan: RunPlan }).plan;
  };

  it("état inchangé → ok ; empreintes stables malgré l'ordre de la liste blanche d'opencode", async (t) => {
    const b = await banc(t);
    const racine = b.racine();
    const plan = await planDe(b, racine);
    b.h.deps.lookup.invalidate();
    assert.deepEqual(await b.preflight.recheck(plan, racine), { ok: true });

    // Les règles sont relues dans un autre ordre à l'intérieur d'une même suite : aucune fausse pause (report MX-EQ).
    const melange = b.h.fake.agents(b.directory).map((a) => (a.name !== "relire-script" ? a : { ...a, permission: melangerListeBlanche(a.permission) }));
    b.h.fake.setAgents(melange);
    b.h.deps.lookup.invalidate();
    assert.deepEqual(await b.preflight.recheck(plan, racine), { ok: true });
  });

  it("chaque écart rend son code : configuration, IA, assistant de la conversation, conversation occupée", async (t) => {
    const b = await banc(t);
    const racine = b.racine();
    const plan = await planDe(b, racine);
    const relire = async () => {
      b.h.deps.lookup.invalidate();
      return b.preflight.recheck(plan, racine);
    };

    // Profondeur de délégation ouverte depuis le lancement.
    b.h.fake.globalConfig = { ...b.h.fake.globalConfig, subagent_depth: 3 };
    assert.deepEqual(await relire(), { ok: false, genre: "changement", code: "profondeur-delegation" });
    const { subagent_depth: _profondeur, ...sansProfondeur } = b.h.fake.globalConfig;
    b.h.fake.globalConfig = sansProfondeur;

    // Extension déclarée depuis le lancement.
    b.h.fake.globalConfig = { ...b.h.fake.globalConfig, mcp: { outil: { type: "local" } } };
    assert.deepEqual(await relire(), { ok: false, genre: "changement", code: "extension-configuree" });
    const { mcp: _mcp, ...sansMcp } = b.h.fake.globalConfig;
    b.h.fake.globalConfig = sansMcp;
    assert.deepEqual(await relire(), { ok: true }, "témoin : tout est remis en place");

    // L'assistant de la conversation a disparu de la liste ; les règles des étapes, elles, n'ont pas bougé.
    b.h.fake.setAgents(agentsParDefaut().filter((a) => a.name !== "build"));
    assert.deepEqual(await relire(), { ok: false, genre: "changement", code: "invalid", details: { champ: "agentConversation" } });
    b.h.fake.setAgents(agentsParDefaut());

    // L'IA d'une étape a quitté le catalogue (lecture locale, sans repli, P1). La fraîcheur relit les assistants : l'assistant
    // n'est plus proposable du tout, et c'est la grammaire qui le dit (422), avant le contrôle par étape.
    const provider = b.h.fake.providers[0];
    const modeles = provider?.models ?? {};
    if (provider) provider.models = Object.fromEntries(Object.entries(modeles).filter(([id]) => id !== "gpt-5-mini"));
    await b.h.deps.catalog.refresh();
    const sansIa = await relire();
    assert.equal(sansIa.ok, false);
    assert.equal((sansIa as { genre: string }).genre, "changement");
    assert.equal((sansIa as { code: string }).code, "equipe-invalide");
    if (provider) provider.models = modeles;
    await b.h.deps.catalog.refresh();

    // La conversation s'est remise à répondre entre l'acceptation et l'injection.
    const original = b.h.deps.client.request.bind(b.h.deps.client);
    t.mock.method(b.h.deps.client, "request", ((method: string, pathname: string, opts?: RequestOptions) =>
      pathname === "/session/status" ? Promise.resolve({ [racine]: { type: "busy" } }) : original(method, pathname, opts)) as typeof b.h.deps.client.request);
    assert.deepEqual(await relire(), { ok: false, genre: "changement", code: "conversation-occupee" });
  });

  it("règles d'un assistant changées → modification, qui prime ; lecture impossible → changement", async (t) => {
    const b = await banc(t);
    const racine = b.racine();
    const plan = await planDe(b, racine);

    // Règles de l'assistant changées : pause « un assistant a changé », même quand une extension est déclarée en même temps.
    b.h.fake.globalConfig = { ...b.h.fake.globalConfig, mcp: { outil: { type: "local" } } };
    b.h.fake.setAgents([...nativeAgents(), agent("relire-script", { permission: { external_directory: "allow" } }), agent("cache", { hidden: true })]);
    b.h.deps.lookup.invalidate();
    assert.deepEqual(await b.preflight.recheck(plan, racine), { ok: false, genre: "modification" });

    // opencode ne répond plus : pause « À vérifier », jamais une supposition.
    await b.h.fake.close();
    b.h.deps.lookup.invalidate();
    assert.deepEqual(await b.preflight.recheck(plan, racine), { ok: false, genre: "changement", code: "opencode-injoignable" });
  });

  it("budget et plafond ne sont PAS rejoués : ils ont été tranchés au lancement (B4 sauté)", async (t) => {
    // En Simple, un plafond trop haut est un refus sec, qu'aucune confirmation ne lève : c'est là que se voit le saut de B4.
    const b = await banc(t, { simpleOuvertes: true });
    const racine = b.racine();
    const corps = await corpsEstime(b, { rootId: racine }, "simple");
    const out = await b.preflight.check(b.entree(corps, { mode: "simple" }));
    assert.equal(out.ok, true, JSON.stringify(out));
    const plan = (out as { ok: true; plan: RunPlan }).plan;

    // Budget du mois ramené au minimum et plafond d'équipe abaissé : au lancement, ces réglages auraient refusé l'équipe.
    b.h.settings.update({ budget: { monthlyUsd: 0.01 }, teams: { maxCapUsd: 0.01 } });
    b.h.deps.lookup.invalidate();
    assert.deepEqual(await b.preflight.recheck(plan, racine), { ok: true }, "l'équipe lancée n'est pas mise en pause par un réglage de budget");

    // Témoin : le même réglage refuse bien un NOUVEAU lancement (le contrôle existe, il n'est simplement pas rejoué).
    const neuf = await corpsEstime(b, { rootId: racine }, "simple");
    assert.equal((await refusDe(b, b.entree(neuf, { mode: "simple" }))).code, "budget-insuffisant");
    assert.equal((await refusDe(b, b.entree({ ...neuf, confirmations: { budget: true } }, { mode: "simple" }))).code, "plafond-trop-haut");
  });
});

/** Mélange les règles d'une même suite (même permission, même action) : ce qu'opencode fait d'un chargement à l'autre. */
function melangerListeBlanche(rules: readonly PermissionRule[]): PermissionRule[] {
  const out: PermissionRule[] = [...rules];
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1];
    const b = out[i];
    if (a && b && a.permission === b.permission && a.action === b.action) {
      out[i - 1] = b;
      out[i] = a;
      i++;
    }
  }
  return out;
}

// --- Le texte du module lui-même -------------------------------------------------------------------------------------------------

describe("L37p : « check » ne touche ni lookup ni client (A4), vérifiable par lecture", () => {
  it("les lectures d'opencode sont toutes dans leur section, et la section des contrôles n'en appelle aucune", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "team-preflight.ts"), "utf8");
    // Les commentaires citent les règles (« ni lookup, ni client ») : seules les lignes de code sont jugées.
    const sansCommentaires = (texte: string): string =>
      texte
        .split("\n")
        .map((ligne) => (/^\s*(\/\/|\*|\/\*)/.test(ligne) ? "" : ligne))
        .join("\n");
    const reperes = {
      debutLectures: "// --- Lectures d'opencode : estimate et recheck SEULEMENT (A4) : début",
      finLectures: "// --- Lectures d'opencode : fin",
      debutControles: "// --- Contrôles sans aucune requête (A4) : début",
      finControles: "// --- Contrôles sans aucune requête (A4) : fin",
    };
    const at = Object.fromEntries(Object.entries(reperes).map(([nom, texte]) => [nom, source.indexOf(texte)])) as Record<keyof typeof reperes, number>;
    for (const [nom, position] of Object.entries(at)) assert.ok(position > 0, `repère absent : ${nom}`);
    assert.ok(at.finLectures > at.debutLectures && at.finControles > at.debutControles, "sections dans l'ordre");

    // Hors de la section des lectures, plus personne ne touche au client d'opencode ni au lookup.
    const dehors = `${sansCommentaires(source.slice(0, at.debutLectures))}\n${sansCommentaires(source.slice(at.finLectures))}`;
    for (const interdit of [/\bc11\.client\b/, /\bc11\.lookup\b/]) {
      assert.equal(interdit.test(dehors), false, `${interdit} hors de la section des lectures`);
    }

    // Et la section des contrôles n'appelle aucune des fonctions qui lisent.
    const controles = sansCommentaires(source.slice(at.debutControles, at.finControles));
    assert.ok(controles.includes("const check ="), "check est dans la section sans requête");
    assert.ok(controles.includes("const groupeA ="), "le groupe A est dans la section sans requête");
    for (const interdit of [/\bc11\.client\b/, /\bc11\.lookup\b/, /\blectures\(/, /\blire[A-Z]/, /\bfetch\(/, /\bplanifier\(/]) {
      assert.equal(interdit.test(controles), false, `la section des contrôles cite ${interdit}`);
    }
  });
});
