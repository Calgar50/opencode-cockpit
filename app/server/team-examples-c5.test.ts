// Tests 1.1 (L45b) : les quatre exemples d'équipe restants de la conception C §12.1, le contexte `methods` passé à
// `validateFlow` par le service et par le pré-lancement, et le contrôle SQL local de « Revue SQL sur réplica ».
//
// Ce que ces tests tiennent :
// - les SIX identifiants de C §12.1 sont au registre, et les DEUX exemples de l'itération 4 n'ont pas bougé d'une ligne
//   (identifiants, `version`, textes de `team-texts.ts`, étapes, aucune méthode, aucune forme de la 5b) ;
// - D-5-25 : `enquete-incident` est livré SANS « Avocat du diable » et `revue-sql` SANS « Seconde lecture de la synthèse » ;
//   le contrôle SQL local de `revue-sql`, lui, est bien livré ;
// - chaque exemple est VALIDE en mode Simple (et en Avancé) avec le catalogue réel : équipes fermées en Simple (U1), mais les
//   exemples sont prêts pour l'ouverture en une ligne ;
// - les estimations typique et maximale sont calculées sur une table de prix FIXE, sans aucune lecture ;
// - l'installation par la VRAIE route pose les assistants et la fiche manquants, reste idempotente et n'écrase aucune fiche ;
// - `PUT /api/teams/:id` et l'aperçu refusent une méthode inconnue ou DÉJÀ posée dans le fichier de l'assistant (problème
//   `methodes`), et le pré-lancement refuse pareil avec ZÉRO requête reçue par le faux opencode (A4, à la lettre) ;
// - `sqlWriteKeywords` est pur, ne repère que des mots entiers, ignore les commentaires SQL et ne se trompe pas sur
//   `UPDATED_AT` ; la ligne de la feuille de lancement est rendue par le modèle PUR, sans aucun appel d'IA ;
// - les textes des six cartes ne portent aucun mot interdit (« avis », jamais « regard »).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { AssistantService as AssistantServiceClass } from "./assistants.ts";
import { CATALOGUE, CATALOGUE_FICHES } from "./assistants-catalogue.ts";
import type { ConfigWriteQueue } from "./config-queue.ts";
import type { EqContext, TeamPreflightPort, TeamRow } from "./contracts-eq.ts";
import { METHODS } from "./methods-catalogue.ts";
import type { ModelPrice } from "./pricing.ts";
import { assistantPermission, effectiveAgentRules, type UiMode } from "./shared/assistant-rules.ts";
import { estimateFlow } from "./shared/flow-estimate.ts";
import { flowAsList, layoutFlow } from "./shared/flow-layout.ts";
import { type FlowMethodsContext, validateFlow } from "./shared/flow.ts";
import { applyMethodBlocks, type Method } from "./shared/methods.ts";
import { sqlWriteKeywords } from "./shared/sql-keywords.ts";
import { planSteps } from "./shared/team-limits.ts";
import { TEXTES } from "./shared/team-texts.ts";
import { TEXTES as TEXTES_C5 } from "./shared/construction-texts.ts";
import type {
  Flow,
  FlowProblem,
  FlowStep,
  StepAssistant,
  TeamEstimateResponse,
  TeamErrorBody,
  TeamExampleView,
  TeamInstallResponse,
  TeamPreviewResponse,
  TeamsListResponse,
  TeamView,
} from "./shared/team-types.ts";
import type { StudioItem, StudioService } from "./studio.ts";
import { exampleById, exampleFlow, TEAM_EXAMPLES } from "./team-examples.ts";
import { createTeamPreflight } from "./team-preflight.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { type FakeAgent, nativeAgents } from "./test-support/fake-opencode.ts";
import type { TierService } from "./tiers.ts";
import { ligneControleSql, vueFeuille } from "../web/pages/chat/team/launch-sheet-model.ts";

const E5 = TEXTES_C5.partout.exemplesEquipes;
const E4 = TEXTES.partout.exemples;

/** Les six identifiants de C §12.1, dans l'ordre du registre : les deux de l'itération 4, puis les quatre de la 5b. */
const EXEMPLES_IT4 = ["revue-sql", "relecture-script"] as const;
const EXEMPLES_5B = ["enquete-incident", "revue-changement-cab", "postmortem", "tri-alerte"] as const;
const EXEMPLES_C121 = [...EXEMPLES_IT4, ...EXEMPLES_5B];

const IA = "github-copilot/gpt-5-mini";

// --- Doublures ------------------------------------------------------------------------------------------------------------------

/** Règles effectives d'un assistant du catalogue en lecture seule : ni délégation, ni Internet, ni action sans demander. */
const reglesLecture = (fiches: readonly string[] = []) => effectiveAgentRules({}, assistantPermission("lecture", false, fiches));

function assistantDe(name: string, over: Partial<StepAssistant> = {}): StepAssistant {
  const entree = CATALOGUE.find((candidat) => candidat.id === name);
  return {
    name,
    title: entree?.title ?? name,
    origin: "catalogue",
    rights: "lecture",
    mode: "primary",
    hidden: false,
    rules: reglesLecture(entree?.fiches ?? []),
    model: IA,
    available: true,
    steps: 20,
    taille: entree?.taskSize ?? "M",
    ...over,
  };
}

/** Assistants du catalogue RÉEL dont les six exemples ont besoin, tels que l'installation les poserait. */
const assistantsDesExemples = (): StepAssistant[] => [...new Set(TEAM_EXAMPLES.flatMap((exemple) => exemple.catalogIds))].map((id) => assistantDe(id));

const ASSISTANTS = assistantsDesExemples();
const CARTE = new Map(ASSISTANTS.map((a) => [a.name, a]));
const NOMS = new Map(ASSISTANTS.map((a) => [a.name, a.title]));

const contexteValidation = (mode: UiMode, methodes?: FlowMethodsContext) => ({
  assistants: ASSISTANTS,
  mode,
  niveauDisponible: () => true,
  ...(methodes ? { methods: methodes } : {}),
});

/** Contexte `methods` fabriqué : le catalogue réel des méthodes « consigne », et ce que porte chaque fichier d'assistant. */
const methodesConnues = (parAssistant: Record<string, string[]> = {}): FlowMethodsContext => ({
  consigne: new Set(METHODS.filter((methode) => methode.kind === "consigne").map((methode) => methode.id)),
  parAssistant: (nom) => new Set(parAssistant[nom] ?? []),
});

/** Tarifs FIXES : les montants attendus ne dépendent ni du catalogue d'IA réel, ni d'une moyenne observée, ni du disque. */
const PRIX: ModelPrice = { rates: { input: 1, cachedInput: 0.1, cacheWrite: null, output: 10 } };

const contexteEstimation = () => ({
  assistants: CARTE,
  iaDe: () => ({ model: IA, variant: null, niveau: null, label: "IA de test" }),
  prix: () => PRIX,
  observe: () => null,
  simultanees: 3,
});

/** Toutes les étapes déclarées d'un déroulé, tous blocs confondus (l'ordre d'exécution, lui, vient de planSteps). */
function toutesLesEtapes(flow: Flow): FlowStep[] {
  const out: FlowStep[] = [];
  for (const bloc of flow.blocs) {
    if (bloc.type === "etape") out.push(bloc.etape);
    else if (bloc.type === "avis") out.push(...bloc.avis, bloc.synthese);
    else if (bloc.type === "relecture") out.push(bloc.auteur, bloc.relecteur);
    else if (bloc.type === "aiguillage") out.push(bloc.aiguilleur, ...bloc.specialistes, ...(bloc.synthese ? [bloc.synthese] : []));
  }
  return out;
}

const flowDe = (id: string): Flow => {
  const exemple = exampleById(id);
  assert.ok(exemple, `exemple « ${id} » absent du registre`);
  return exampleFlow(exemple, NOMS.size > 0 ? new Map() : new Map());
};

/**
 * Studio simulé qui garde les CORPS écrits et permet d'en poser à l'avance : sans corps réel, ni `methodIdsIn` (méthodes du
 * fichier) ni « aucune fiche écrasée » ne seraient contrôlables.
 */
function studioEspion(initial: ReadonlyArray<{ kind: string; name: string; body: string }> = []): {
  studio: StudioService;
  ecrits: string[];
  corps(kind: string, name: string): string | null;
} {
  const items = new Map<string, StudioItem>();
  const ecrits: string[] = [];
  const poser = (kind: string, name: string, frontmatter: Record<string, unknown>, body: string) => {
    const item = {
      kind,
      name,
      scope: "global",
      project: null,
      file: `${kind}/${name}.md`,
      frontmatter,
      body,
      error: null,
      files: [],
      updatedAt: 1,
    } as unknown as StudioItem;
    items.set(`${kind}/${name}`, item);
    return item;
  };
  for (const entree of initial) poser(entree.kind, entree.name, {}, entree.body);
  const studio = {
    save: async (kind: string, _scope: unknown, input: { name: string; frontmatter: Record<string, unknown>; body: string }) => {
      ecrits.push(`${kind}/${input.name}`);
      return poser(kind, input.name, input.frontmatter, input.body);
    },
    remove: async () => true,
    get: async (kind: string, name: string) => items.get(`${kind}/${name}`) ?? null,
    list: async (kind: string) => [...items.values()].filter((item) => item.kind === kind),
    applyModels: async (_plan: unknown[], beforeWrite?: () => Promise<void>) => void (await beforeWrite?.()),
    ensureClassifierAgent: async () => undefined,
  } as unknown as StudioService;
  return { studio, ecrits, corps: (kind, name) => items.get(`${kind}/${name}`)?.body ?? null };
}

/** Port de pré-lancement simulé : il ne rend que les assistants (le service n'estime rien dans ces tests). */
const preflightSimule = (assistants: readonly StepAssistant[]): TeamPreflightPort => ({
  assistants: async () => new Map(assistants.map((a) => [a.name, a])),
  estimate: async () => ({ ok: false, status: 502, code: "opencode-injoignable" }),
  check: async () => ({ ok: false, status: 409, code: "a-venir" }),
  recheck: async () => ({ ok: false, genre: "changement", code: "a-venir" }),
});

interface Banc extends CockpitHarness {
  ecrits: string[];
  corps(kind: string, name: string): string | null;
}

/** Harnais du module « teams » : Studio complet (corps réels), AssistantService réel, port de pré-lancement simulé. */
async function banc(
  t: TestContext,
  options: { assistants?: readonly StepAssistant[]; fichiers?: ReadonlyArray<{ kind: string; name: string; body: string }> } = {},
): Promise<Banc> {
  const { studio, ecrits, corps } = studioEspion(options.fichiers ?? []);
  const ref: { h?: CockpitHarness } = {};
  const h = await startCockpit(t, {
    settings: { ui: { mode: "avance" } },
    equipes: ["teams"],
    eqPorts: { preflight: preflightSimule(options.assistants ?? ASSISTANTS) },
    deps: (base) => ({
      studio,
      assistants: new AssistantServiceClass({
        db: base.db,
        env: base.env,
        client: base.client,
        studio,
        lookup: base.lookup,
        tiers: base.tiers as TierService,
        ledger: base.ledger,
        settings: base.settings,
        catalog: base.catalog,
        projects: base.projects,
        hub: base.hub,
        log: base.log,
        queue: base.configQueue as ConfigWriteQueue,
        reloadBusy: () => ref.h?.cockpit.c11.reloadBusy() ?? false,
      }),
    }),
  });
  ref.h = h;
  // Les trois niveaux d'IA doivent se résoudre : l'entrée « Préparer une revue CAB » du catalogue est de niveau Expert, dont
  // aucun candidat n'est servi par le faux par défaut. Sans cela, l'installation de l'exemple du comité rendrait
  // « ia-indisponible » pour une raison étrangère à ce paquet.
  const copilot = h.fake.providers.find((fournisseur) => fournisseur.id === "github-copilot");
  assert.ok(copilot, "fournisseur github-copilot absent du faux");
  copilot.models["claude-opus-5"] = {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    capabilities: { toolcall: true, reasoning: true },
    variants: { low: {}, medium: {}, high: {} },
    limit: { context: 1_000_000, output: 64_000 },
    status: "active",
  };
  await h.deps.catalog.refresh();
  return Object.assign(h, { ecrits, corps });
}

async function liste(h: CockpitHarness): Promise<TeamsListResponse> {
  const res = await h.call("GET", "/api/teams", { headers: h.headers.authed });
  assert.equal(res.status, 200, res.body);
  return res.json<TeamsListResponse>();
}

async function installer(h: CockpitHarness, id: string): Promise<TeamInstallResponse> {
  const res = await h.call("POST", `/api/teams/examples/${id}/install`, { headers: h.headers.mutating, body: {} });
  assert.equal(res.status, 200, res.body);
  return res.json<TeamInstallResponse>();
}

// --- 1. Le registre : les six exemples de C §12.1, ceux de l'it4 intacts ----------------------------------------------------------

describe("L45b : registre des exemples (C §12.1)", () => {
  it("les six identifiants sont au registre, dans l'ordre, avec `exemple_version` 1", () => {
    assert.deepEqual(TEAM_EXAMPLES.map((exemple) => exemple.id), EXEMPLES_C121);
    for (const exemple of TEAM_EXAMPLES) assert.equal(exemple.version, 1, exemple.id);
    // Chaque exemple nomme des entrées RÉELLES du catalogue : une installation ne peut pas buter sur un identifiant inventé.
    for (const exemple of TEAM_EXAMPLES) {
      for (const catalogId of exemple.catalogIds) {
        assert.ok(CATALOGUE.some((entree) => entree.id === catalogId), `${exemple.id} : ${catalogId} absent du catalogue`);
      }
    }
  });

  it("les deux exemples de l'itération 4 ne sont pas réécrits : textes de team-texts.ts, étapes, aucune méthode, formes de l'it4", () => {
    const sql = exampleById("revue-sql");
    const script = exampleById("relecture-script");
    assert.ok(sql && script);
    assert.equal(sql.titre, E4["revue-sql"].titre);
    assert.equal(sql.description, E4["revue-sql"].description);
    assert.equal(script.titre, E4["relecture-script"].titre);
    assert.equal(script.description, E4["relecture-script"].description);
    assert.deepEqual(sql.catalogIds, ["relire-requete-sql"]);
    assert.deepEqual(script.catalogIds, ["relire-script"]);
    assert.deepEqual(
      planSteps(sql.flow).map((planned) => [planned.stepId, planned.role, planned.tour]),
      [
        ["exactitude", "avis", 1],
        ["performance", "avis", 1],
        ["donnees-sensibles", "avis", 1],
        ["synthese", "synthese", 1],
      ],
    );
    assert.deepEqual(
      planSteps(script.flow).map((planned) => planned.stepId),
      ["standards", "securite", "exploitation-nuit", "consolidation"],
    );
    for (const exemple of [sql, script]) {
      assert.deepEqual([...new Set(exemple.flow.blocs.map((bloc) => bloc.type))].sort(), exemple.id === "revue-sql" ? ["avis"] : ["etape", "pause"]);
      for (const etape of toutesLesEtapes(exemple.flow)) {
        assert.equal(etape.methodes, undefined, `${exemple.id} : ${etape.id} porte une méthode`);
        assert.equal(etape.niveau, null, `${exemple.id} : ${etape.id}`);
      }
    }
  });

  it("D-5-25 : aucun bloc facultatif — pas d'« Avocat du diable » dans l'enquête, pas de seconde lecture dans la revue SQL", () => {
    const enquete = flowDe("enquete-incident");
    const sql = flowDe("revue-sql");
    // L'étape facultative de C §12.1 employait la méthode « Avocat du diable » : ni son titre, ni son identifiant, ni la
    // méthode ne doivent apparaître. La colonne `team_runs.facultatifs` reste `'[]'` : aucun bloc ne se dit facultatif.
    for (const flow of [enquete, sql]) {
      const texte = JSON.stringify(flow).toLowerCase();
      assert.equal(texte.includes("avocat"), false);
      assert.equal(texte.includes("seconde lecture"), false);
      assert.equal(texte.includes("facultatif"), false);
      for (const etape of toutesLesEtapes(flow)) assert.equal((etape.methodes ?? []).includes("avocat-du-diable"), false, etape.id);
    }
    assert.deepEqual(
      planSteps(enquete).map((planned) => planned.stepId),
      ["changement", "infrastructure", "donnees", "synthese"],
    );
  });

  it("les quatre exemples de la 5b : formes, bornes et réglages attendus (relecture 2 tours avec pause, aiguillage 5 spécialistes)", () => {
    const postmortem = flowDe("postmortem");
    const relecture = postmortem.blocs[0];
    assert.ok(relecture && relecture.type === "relecture");
    assert.equal(relecture.toursMax, 2);
    assert.equal(relecture.pauseAvantRelecture, true);
    assert.equal(relecture.auteur.assistant, "rediger-compte-rendu-incident");
    assert.deepEqual(relecture.auteur.methodes, ["cinq-pourquoi"]);
    assert.equal(relecture.relecteur.assistant, "relecteur-critique");

    const tri = flowDe("tri-alerte");
    const aiguillage = tri.blocs[0];
    assert.ok(aiguillage && aiguillage.type === "aiguillage");
    assert.equal(aiguillage.choixMax, 2);
    assert.equal(aiguillage.specialistes.length, 5);
    assert.ok(aiguillage.specialistes.every((step) => step.assistant === "expliquer-alerte"));
    assert.equal(aiguillage.aiguilleur.assistant, "aiguilleur");
    assert.equal(aiguillage.synthese?.assistant, "synthese-rapport");
    assert.equal(aiguillage.repli, "expliquer-alerte");

    // Revue CAB : à la suite, avec une pause au milieu ; enquête : un seul bloc d'avis.
    assert.deepEqual(flowDe("revue-changement-cab").blocs.map((bloc) => bloc.type), ["etape", "pause", "etape", "etape"]);
    assert.deepEqual(flowDe("enquete-incident").blocs.map((bloc) => bloc.type), ["avis"]);
  });

  it("toutes les étapes des six exemples sont en LECTURE SEULE : aucune IA choisie par l'équipe, aucun lien du mode Avancé", () => {
    for (const exemple of TEAM_EXAMPLES) {
      for (const etape of toutesLesEtapes(exampleFlow(exemple, new Map()))) {
        assert.equal(etape.niveau, null, `${exemple.id} : ${etape.id} choisit une IA`);
        assert.equal(typeof etape.recoit, "string", `${exemple.id} : ${etape.id} emploie un lien du mode Avancé`);
      }
      // Les assistants employés sont tous du profil « lecture » au catalogue.
      for (const catalogId of exemple.catalogIds) {
        assert.equal(CATALOGUE.find((entree) => entree.id === catalogId)?.rights, "lecture", `${exemple.id} : ${catalogId}`);
      }
    }
  });

  it("`exampleFlow` renomme aussi le `repli` d'un aiguillage : jamais un identifiant de catalogue affiché à la place du nom réel", () => {
    const exemple = exampleById("tri-alerte");
    assert.ok(exemple);
    const flow = exampleFlow(exemple, new Map([["expliquer-alerte", "expliquer-alerte-2"], ["aiguilleur", "aiguilleur-2"]]));
    const bloc = flow.blocs[0];
    assert.ok(bloc && bloc.type === "aiguillage");
    assert.equal(bloc.repli, "expliquer-alerte-2");
    assert.equal(bloc.aiguilleur.assistant, "aiguilleur-2");
    assert.ok(bloc.specialistes.every((step) => step.assistant === "expliquer-alerte-2"));
    // Le déroulé de référence n'a pas bougé : la copie seule est renommée.
    const reference = exampleById("tri-alerte")?.flow.blocs[0];
    assert.ok(reference && reference.type === "aiguillage");
    assert.equal(reference.repli, "expliquer-alerte");
  });
});

// --- 2. Validité en Simple et estimations sur une table de prix fixe ---------------------------------------------------------------

describe("L45b : les six exemples sont valides en Simple (U1 : fermées, mais prêtes pour l'ouverture en une ligne)", () => {
  for (const id of EXEMPLES_C121) {
    it(`${id} : aucun problème bloquant en Simple ni en Avancé, avec le contexte des méthodes`, () => {
      const flow = flowDe(id);
      // Contexte des méthodes complet : aucune méthode n'est encore posée dans le fichier des assistants (rien n'est attaché
      // automatiquement, C §16 n° 5), donc la méthode de `postmortem` est acceptée.
      const methodes = methodesConnues();
      for (const mode of ["simple", "avance"] as UiMode[]) {
        const problemes = validateFlow(flow, contexteValidation(mode, methodes)).filter((probleme) => probleme.bloquant);
        assert.deepEqual(problemes.map((probleme) => `${probleme.code}/${probleme.etape ?? "-"}`), [], `${id} (${mode})`);
      }
    });
  }

  it("estimations typique et maximale sur une table de prix FIXE : le maximum couvre les tours et les spécialistes", () => {
    const fixe = (id: string) => estimateFlow(flowDe(id), contexteEstimation());

    // Formes de l'itération 4 : un SEUL chemin (le typique est le maximal), donc aucune répétition à annoncer. L'écart entre
    // les deux montants ne vient alors que de la taille prise au-dessus pour l'estimation haute.
    for (const id of ["revue-sql", "relecture-script", "enquete-incident", "revue-changement-cab"]) {
      const flow = flowDe(id);
      const estimation = fixe(id);
      assert.deepEqual(planSteps(flow, { chemin: "typique" }), planSteps(flow, { chemin: "maximal" }), `${id} : un seul chemin`);
      assert.equal(estimation.repetitions, undefined, `${id} : ni relecture ni aiguillage`);
      assert.ok(estimation.typique > 0 && estimation.maximum > estimation.typique, id);
    }

    // Relecture : le chemin typique est un aller-retour, le maximal 1 + 2 × toursMax appels.
    const postmortem = fixe("postmortem");
    assert.deepEqual(postmortem.repetitions, { tours: 2, specialistes: 0 });
    assert.ok(postmortem.maximum > postmortem.typique, "le maximum couvre les deux tours et la révision finale");
    assert.equal(planSteps(flowDe("postmortem"), { chemin: "typique" }).length, 2);
    assert.equal(planSteps(flowDe("postmortem"), { chemin: "maximal" }).length, 5);

    // Aiguillage : un spécialiste au chemin typique, `choixMax` + la synthèse au maximal.
    const tri = fixe("tri-alerte");
    assert.deepEqual(tri.repetitions, { tours: 0, specialistes: 2 });
    assert.ok(tri.maximum > tri.typique, "le maximum couvre deux spécialistes et la synthèse");
    assert.equal(planSteps(flowDe("tri-alerte"), { chemin: "typique" }).length, 2);
    assert.equal(planSteps(flowDe("tri-alerte"), { chemin: "maximal" }).length, 4);

    // Le plafond EST l'estimation haute, et il ne dépend d'aucune lecture : deux calculs de suite rendent le même montant.
    for (const id of EXEMPLES_C121) {
      const a = fixe(id);
      assert.deepEqual(a, fixe(id), `${id} : estimation non déterministe`);
      assert.equal(a.plafond, a.maximum, id);
    }
  });
});

// --- 3. Contrôle SQL local (C §12.1, toujours livré) -------------------------------------------------------------------------------

describe("L45b : `sqlWriteKeywords` (pur, aucun appel d'IA)", () => {
  it("repère les mots d'écriture, quelle que soit la casse, sans doublon et dans l'ordre d'apparition", () => {
    assert.deepEqual(sqlWriteKeywords("update client set x = 1; DELETE FROM client; update autre set y = 2"), ["UPDATE", "DELETE"]);
    assert.deepEqual(sqlWriteKeywords("MERGE INTO t USING s ON (1=1)"), ["MERGE"]);
    assert.deepEqual(sqlWriteKeywords("Truncate table t; drop table u; alter table v; create index w; exec p"), [
      "TRUNCATE",
      "DROP",
      "ALTER",
      "CREATE",
      "EXEC",
    ]);
    assert.deepEqual(sqlWriteKeywords("insert into t values (1)"), ["INSERT"]);
  });

  it("mots ENTIERS seulement : aucun faux positif sur UPDATED_AT, CREATED_BY, sp_droplogin ni « insertion »", () => {
    assert.deepEqual(sqlWriteKeywords("SELECT id, UPDATED_AT, CREATED_BY FROM t WHERE sp_droplogin IS NULL"), []);
    assert.deepEqual(sqlWriteKeywords("SELECT * FROM insertions"), []);
    assert.deepEqual(sqlWriteKeywords("SELECT deleted_at FROM t"), []);
    assert.deepEqual(sqlWriteKeywords("SELECT x_update, update_y FROM t"), []);
    // Mais un mot collé à une ponctuation reste un mot entier.
    assert.deepEqual(sqlWriteKeywords("BEGIN;DELETE FROM t;"), ["DELETE"]);
  });

  it("commentaires SQL ignorés : `-- …` jusqu'à la fin de la ligne et `/* … */`, même non terminé", () => {
    assert.deepEqual(sqlWriteKeywords("SELECT 1 -- DELETE FROM t"), []);
    assert.deepEqual(sqlWriteKeywords("SELECT 1 /* UPDATE t SET x = 1 */ FROM t"), []);
    assert.deepEqual(sqlWriteKeywords("SELECT 1 /* DROP TABLE t"), []);
    assert.deepEqual(sqlWriteKeywords("-- rien\nDELETE FROM t"), ["DELETE"], "seule la ligne du commentaire est ignorée");
    // Le commentaire devient une espace : deux mots séparés par un commentaire ne se collent pas en un seul.
    assert.deepEqual(sqlWriteKeywords("DROP/* x */TABLE t"), ["DROP"]);
  });

  it("texte vide ou sans SQL : aucune ligne, et la fonction ne lève jamais", () => {
    assert.deepEqual(sqlWriteKeywords(""), []);
    assert.deepEqual(sqlWriteKeywords("Relis cette requête de lecture, s'il te plaît."), []);
    assert.deepEqual(sqlWriteKeywords("SELECT * FROM client WHERE actif = 1"), []);
  });
});

describe("L45b : ligne de la feuille de lancement de « Revue SQL sur réplica » (modèle pur)", () => {
  const equipe = (over: Partial<TeamView> = {}): TeamView =>
    ({
      id: "revue-sql",
      titre: E4["revue-sql"].titre,
      description: E4["revue-sql"].description,
      flow: flowDe("revue-sql"),
      forme: "avis",
      origine: "exemple",
      exempleId: "revue-sql",
      etat: "ok",
      estimate: null,
      layout: layoutFlow(flowDe("revue-sql"), NOMS),
      liste: flowAsList(flowDe("revue-sql"), NOMS),
      droits: [],
      dernierLancement: null,
      ...over,
    }) as unknown as TeamView;

  it("mot d'écriture repéré : la ligne du texte, remplie avec les mots, sans aucun appel d'IA", () => {
    const ligne = ligneControleSql(equipe(), "UPDATE client SET actif = 0 WHERE id = 1");
    assert.equal(ligne, E5.sqlRepere.replace("{mots}", "UPDATE"));
    assert.equal(ligneControleSql(equipe(), "delete from t; drop table u"), E5.sqlRepere.replace("{mots}", "DELETE, DROP"));
    // Aucun gabarit « {nom} » ne reste affiché.
    assert.equal(/\{[a-z]+\}/i.test(ligne ?? ""), false);
  });

  it("aucune ligne quand rien n'est repéré, quand la demande est absente, ou pour une équipe qui ne vient pas de cet exemple", () => {
    assert.equal(ligneControleSql(equipe(), "SELECT * FROM client"), null);
    assert.equal(ligneControleSql(equipe(), undefined), null);
    assert.equal(ligneControleSql(equipe({ exempleId: "relecture-script" }), "DELETE FROM t"), null);
    assert.equal(ligneControleSql(equipe({ exempleId: null }), "DELETE FROM t"), null);
  });

  it("`vueFeuille` porte la ligne, même sans estimation aboutie (le contrôle est local)", () => {
    const etat = {
      equipe: equipe(),
      advanced: true,
      estimation: null,
      estimationEnCours: false,
      refus: null,
      accords: { workspace: false, secret: false, plafond: false, budget: false, gardeBudget: false },
      occupee: false,
      envoiEnCours: false,
      detailOuvert: false,
      demande: "TRUNCATE TABLE journal",
    };
    assert.equal(vueFeuille(etat).sql, E5.sqlRepere.replace("{mots}", "TRUNCATE"));
    assert.equal(vueFeuille({ ...etat, demande: "SELECT 1" }).sql, null);
    assert.equal(vueFeuille({ ...etat, demande: undefined }).sql, null);
  });
});

// --- 4. Installation d'un exemple : assistants, fiche, idempotence ------------------------------------------------------------------

describe("L45b : installation des exemples de la 5b par leur vraie route", () => {
  it("« Compte rendu d'incident relu » : les deux assistants ET la fiche manquants sont posés, puis rien de plus au second appel", async (t) => {
    const h = await banc(t);
    const avant = await liste(h);
    const carte = avant.exemples.find((exemple) => exemple.id === "postmortem");
    assert.ok(carte, "l'exemple « postmortem » n'est pas dans la galerie");
    assert.deepEqual(
      carte.assistantsManquants,
      ["rediger-compte-rendu-incident", "relecteur-critique"].map((id) => CATALOGUE.find((entree) => entree.id === id)?.title),
      "la boîte d'installation annonce les assistants qu'elle va poser",
    );
    assert.equal(carte.installee, false);

    const installee = await installer(h, "postmortem");
    assert.equal(installee.team.origine, "exemple");
    assert.equal(installee.team.exempleId, "postmortem");
    assert.equal(installee.team.titre, E5.postmortem.titre);
    assert.deepEqual(installee.assistantsInstalles, carte.assistantsManquants);
    assert.deepEqual(h.ecrits.filter((fichier) => fichier.startsWith("agents/")), [
      "agents/rediger-compte-rendu-incident",
      "agents/relecteur-critique",
    ]);
    // La fiche exigée par l'entrée du catalogue est posée avec l'assistant (une seule fois).
    assert.deepEqual(h.ecrits.filter((fichier) => fichier.startsWith("skills/")), ["skills/anonymisation-donnees", "skills/postmortem-sans-reproche"]);

    const ecritsApres = [...h.ecrits];
    const second = await installer(h, "postmortem");
    assert.deepEqual(second.assistantsInstalles, []);
    assert.deepEqual(h.ecrits, ecritsApres, "second appel : aucun fichier réécrit");
    assert.equal((await liste(h)).teams.length, 1);
    assert.equal((await liste(h)).exemples.find((exemple) => exemple.id === "postmortem")?.installee, true);
    h.assertNoGlobalRestart();
  });

  it("une fiche déjà présente n'est JAMAIS écrasée, même si son texte a été modifié à la main", async (t) => {
    const fiche = CATALOGUE_FICHES.find((candidate) => candidate.name === "postmortem-sans-reproche");
    assert.ok(fiche, "fiche postmortem-sans-reproche absente du cockpit");
    const h = await banc(t, { fichiers: [{ kind: "skills", name: "postmortem-sans-reproche", body: "Ma version à moi." }] });

    await installer(h, "postmortem");
    assert.equal(h.corps("skills", "postmortem-sans-reproche"), "Ma version à moi.", "la fiche de l'utilisateur a été écrasée");
    assert.equal(h.ecrits.includes("skills/postmortem-sans-reproche"), false, "la fiche déjà là n'est pas réécrite");
    // L'autre fiche du même assistant, elle, manquait : elle est posée.
    assert.ok(h.ecrits.includes("skills/anonymisation-donnees"));
  });

  it("les quatre exemples de la 5b s'installent, chacun avec ses assistants, et l'équipe reste valide en Simple", async (t) => {
    const h = await banc(t);
    for (const id of EXEMPLES_5B) {
      const installee = await installer(h, id);
      assert.equal(installee.team.exempleId, id);
      const problemes = validateFlow(installee.team.flow, contexteValidation("simple", methodesConnues())).filter((probleme) => probleme.bloquant);
      assert.deepEqual(problemes.map((probleme) => probleme.code), [], `${id} : équipe installée refusée en Simple`);
      // Le déroulé enregistré nomme les assistants RÉELLEMENT installés.
      for (const etape of toutesLesEtapes(installee.team.flow)) {
        assert.ok(h.ecrits.includes(`agents/${etape.assistant}`), `${id} : ${etape.assistant} n'a pas de fichier d'agent`);
      }
      // Calculs dérivés RENDUS : un déroulé de relecture ou d'aiguillage tenu pour mal formé laisserait la disposition, la
      // liste et les droits vides, et l'onglet Équipes afficherait une équipe muette.
      assert.ok(installee.team.layout.length > 0, `${id} : disposition vide`);
      assert.ok(installee.team.liste.length > 0, `${id} : liste vide`);
      assert.ok(installee.team.droits.length > 0, `${id} : droits vides`);
    }
    assert.equal((await liste(h)).teams.length, EXEMPLES_5B.length);
    h.assertNoGlobalRestart();
  });

  it("`PUT /api/teams/:id` accepte un déroulé de relecture et un d'aiguillage : leur forme est bien reconnue par le service", async (t) => {
    const h = await banc(t);
    for (const id of ["postmortem", "tri-alerte"]) {
      const flow = flowDe(id);
      const res = await h.call("PUT", `/api/teams/copie-${id}`, { headers: h.headers.mutating, body: { titre: `Copie de ${id}`, description: "", flow } });
      assert.equal(res.status, 200, `${id} : ${res.body}`);
      const vue = res.json<TeamView>();
      assert.deepEqual(vue.flow.blocs.map((bloc) => bloc.type), flow.blocs.map((bloc) => bloc.type), id);
      assert.ok(vue.layout.length > 0, `${id} : disposition vide`);
      assert.ok(vue.liste.length > 0, `${id} : liste vide`);
    }
  });
});

// --- 5. Contexte des méthodes : service (aperçu, enregistrement) --------------------------------------------------------------------

/** Déroulé d'une seule étape portant les méthodes demandées, sur l'assistant donné. */
const flowMethodes = (assistant: string, methodes: string[]): Flow => ({
  version: 1,
  blocs: [
    {
      type: "etape",
      id: "bloc",
      etape: { id: "seule", titre: "Rédaction", assistant, niveau: null, taille: "M", consigne: "Rédige.", recoit: "demande", methodes },
    },
  ],
});

const corpsPut = (flow: Flow) => ({ titre: "Mon équipe", description: "Une étape.", flow });

describe("L45b : contexte `methods` passé par le service (C §5.2)", () => {
  const AUTEUR = "rediger-compte-rendu-incident";
  const cinqPourquoi = METHODS.find((methode) => methode.id === "cinq-pourquoi") as Method;

  it("aperçu et PUT : une méthode INCONNUE du catalogue rend un problème `methodes` bloquant", async (t) => {
    const h = await banc(t);
    const flow = flowMethodes(AUTEUR, ["pas-une-methode"]);

    const apercu = await h.call("POST", "/api/teams/preview", { headers: h.headers.mutating, body: { flow } });
    assert.equal(apercu.status, 200, apercu.body);
    const problemes = apercu.json<TeamPreviewResponse>().problems;
    assert.deepEqual(problemes.filter((probleme: FlowProblem) => probleme.code === "methodes").map((probleme) => [probleme.etape, probleme.bloquant]), [["seule", true]]);

    const put = await h.call("PUT", "/api/teams/essai", { headers: h.headers.mutating, body: corpsPut(flow) });
    assert.equal(put.status, 422, put.body);
    const refus = put.json<TeamErrorBody>();
    assert.equal(refus.error, "equipe-invalide");
    assert.ok((refus.problems ?? []).some((probleme) => probleme.code === "methodes"), put.body);
    assert.equal((await liste(h)).teams.length, 0, "rien n'a été enregistré");
  });

  it("aperçu et PUT : une méthode DÉJÀ posée dans le fichier de l'assistant rend le même problème", async (t) => {
    // Le fichier de l'assistant porte déjà le bloc de « 5 pourquoi » : le FICHIER fait foi (D-5-07).
    const corps = applyMethodBlocks("Tu rédiges un compte rendu.", [cinqPourquoi]);
    const h = await banc(t, { fichiers: [{ kind: "agents", name: AUTEUR, body: corps }] });
    const flow = flowMethodes(AUTEUR, ["cinq-pourquoi"]);

    const apercu = await h.call("POST", "/api/teams/preview", { headers: h.headers.mutating, body: { flow } });
    assert.equal(apercu.status, 200, apercu.body);
    assert.ok(apercu.json<TeamPreviewResponse>().problems.some((probleme) => probleme.code === "methodes" && probleme.bloquant), apercu.body);

    const put = await h.call("PUT", "/api/teams/essai", { headers: h.headers.mutating, body: corpsPut(flow) });
    assert.equal(put.status, 422, put.body);
    assert.ok((put.json<TeamErrorBody>().problems ?? []).some((probleme) => probleme.code === "methodes"));
  });

  it("le même déroulé passe quand le fichier ne porte pas la méthode : c'est bien le contexte qui décide", async (t) => {
    const h = await banc(t, { fichiers: [{ kind: "agents", name: AUTEUR, body: "Tu rédiges un compte rendu." }] });
    const flow = flowMethodes(AUTEUR, ["cinq-pourquoi"]);
    const apercu = await h.call("POST", "/api/teams/preview", { headers: h.headers.mutating, body: { flow } });
    assert.equal(apercu.status, 200, apercu.body);
    assert.deepEqual(apercu.json<TeamPreviewResponse>().problems.filter((probleme) => probleme.code === "methodes"), []);
    const put = await h.call("PUT", "/api/teams/essai", { headers: h.headers.mutating, body: corpsPut(flow) });
    assert.equal(put.status, 200, put.body);
    assert.deepEqual(put.json<TeamView>().flow.blocs.length, 1);
  });

  it("une méthode de genre « relecture » (Seconde lecture) ne s'attache pas à une étape", async (t) => {
    const h = await banc(t);
    const apercu = await h.call("POST", "/api/teams/preview", { headers: h.headers.mutating, body: { flow: flowMethodes(AUTEUR, ["seconde-lecture"]) } });
    assert.equal(apercu.status, 200, apercu.body);
    assert.ok(apercu.json<TeamPreviewResponse>().problems.some((probleme) => probleme.code === "methodes" && probleme.bloquant), apercu.body);
  });
});

// --- 6. Contexte des méthodes au PRÉ-LANCEMENT : A4, zéro requête ---------------------------------------------------------------------

const T0 = 1_800_000_000_000;

/** Problèmes portés par un refus du pré-lancement : ils voyagent dans `details.problems` (routes-team-runs.ts les rend tels quels). */
function problemesDuRefus(refus: unknown): FlowProblem[] {
  const details = (refus as { details?: { problems?: FlowProblem[] } }).details;
  return details?.problems ?? [];
}

describe("L45b : contexte `methods` au pré-lancement (A4, zéro requête à la lettre)", () => {
  const AUTEUR = "rediger-compte-rendu-incident";
  const cinqPourquoi = METHODS.find((methode) => methode.id === "cinq-pourquoi") as Method;

  const agent = (name: string): FakeAgent => ({
    name,
    mode: "primary",
    options: {},
    model: { providerID: "github-copilot", modelID: "gpt-5-mini" },
    permission: reglesLecture([]),
    steps: 40,
  });

  const equipeDe = (flow: Flow): TeamRow => ({
    id: "postmortem",
    titre: E5.postmortem.titre,
    description: E5.postmortem.description,
    flow: JSON.stringify(flow),
    origine: "exemple",
    exemple_id: "postmortem",
    exemple_version: 1,
    avance: 0,
    created_at: 1,
    updated_at: 1,
  });

  /** Harnais du pré-lancement RÉEL : faux opencode, Studio qui porte un corps de fichier d'agent choisi. */
  async function bancPreflight(t: TestContext, corpsAgent: string, autres: readonly string[] = []) {
    const noms = [AUTEUR, ...autres];
    const { studio } = studioEspion([
      { kind: "agents", name: AUTEUR, body: corpsAgent },
      ...autres.map((nom) => ({ kind: "agents", name: nom, body: "Tu relis." })),
    ]);
    const h = await startCockpit(t, { settings: { ui: { mode: "avance" } }, equipes: ["teamPreflight"], deps: () => ({ studio }) });
    // Un sous-dossier du workspace : la racine même demanderait la confirmation P9, étrangère à ce que ce test juge.
    fs.mkdirSync(path.join(h.deps.env.workspaceDir, "projet"), { recursive: true });
    h.fake.setAgents([...nativeAgents(), ...noms.map((nom) => agent(nom))]);
    for (const nom of noms) {
      h.db
        .prepare("INSERT INTO item_meta (kind, name, title, rights, task_size, origin, created_at, updated_at) VALUES ('agents', ?, ?, 'lecture', 'M', 'catalogue', 0, 0)")
        .run(nom, nom);
    }
    const eq: EqContext = h.cockpit.equipes.eq;
    return { h, preflight: createTeamPreflight(eq, { now: () => T0 }), directory: `${h.fake.directory}/projet` };
  }

  const corpsLancement = (directory: string, estimateSha256: string) => ({
    directory,
    rootId: null,
    demande: "Rédige le compte rendu de la coupure de mardi.",
    fichiers: [],
    agentConversation: "build",
    estimateSha256,
    confirmations: {},
  });

  it("méthode déjà posée dans le fichier d'agent : refus 422 `methodes` SANS aucune requête au faux opencode", async (t) => {
    const flow = flowMethodes(AUTEUR, ["cinq-pourquoi"]);
    const { h, preflight, directory } = await bancPreflight(t, applyMethodBlocks("Tu rédiges.", [cinqPourquoi]));
    const equipe = equipeDe(flow);

    // L'estimation est le SEUL point qui lit : elle voit déjà le blocage et le dit, sans rien envoyer.
    const estimation = await preflight.estimate(equipe, { directory, rootId: null }, "avance");
    assert.equal(estimation.ok, true, JSON.stringify(estimation));
    const reponse = (estimation as { ok: true; response: TeamEstimateResponse }).response;
    assert.equal(reponse.blocage?.code, "equipe-invalide", JSON.stringify(reponse.blocage));
    assert.ok(reponse.problems.some((probleme) => probleme.code === "methodes" && probleme.bloquant), JSON.stringify(reponse.problems));

    // Le pré-lancement, lui, n'émet RIEN : ni pour lire les fichiers, ni pour juger la méthode.
    const avant = h.fake.requests.length;
    const refus = await preflight.check({
      team: equipe,
      body: corpsLancement(directory, reponse.estimateSha256),
      mode: "avance",
      confirmed: false,
    });
    const emises = h.fake.requests.slice(avant).map((requete) => `${requete.method} ${requete.pathname}`);
    assert.deepEqual(emises, [], `requêtes émises pendant le refus : ${emises.join(", ")}`);
    assert.equal(refus.ok, false, JSON.stringify(refus));
    assert.equal((refus as { status: number }).status, 422);
    assert.equal((refus as { code: string }).code, "equipe-invalide");
    assert.ok(problemesDuRefus(refus).some((probleme) => probleme.code === "methodes"), JSON.stringify(refus));
    h.assertNoGlobalRestart();
  });

  it("méthode inconnue du catalogue : même refus, toujours sans aucune requête", async (t) => {
    const { h, preflight, directory } = await bancPreflight(t, "Tu rédiges.");
    const equipe = equipeDe(flowMethodes(AUTEUR, ["pas-une-methode"]));
    const estimation = await preflight.estimate(equipe, { directory, rootId: null }, "avance");
    assert.equal(estimation.ok, true, JSON.stringify(estimation));
    const reponse = (estimation as { ok: true; response: TeamEstimateResponse }).response;

    const avant = h.fake.requests.length;
    const refus = await preflight.check({ team: equipe, body: corpsLancement(directory, reponse.estimateSha256), mode: "avance", confirmed: false });
    assert.deepEqual(h.fake.requests.slice(avant).map((requete) => `${requete.method} ${requete.pathname}`), []);
    assert.equal(refus.ok, false);
    assert.ok(problemesDuRefus(refus).some((probleme) => probleme.code === "methodes"), JSON.stringify(refus));
  });

  it("fichier d'agent SANS la méthode : le pré-lancement accepte, et la méthode n'a été lue nulle part ailleurs", async (t) => {
    const { h, preflight, directory } = await bancPreflight(t, "Tu rédiges, sans méthode attachée.");
    const equipe = equipeDe(flowMethodes(AUTEUR, ["cinq-pourquoi"]));
    const estimation = await preflight.estimate(equipe, { directory, rootId: null }, "avance");
    assert.equal(estimation.ok, true, JSON.stringify(estimation));
    const reponse = (estimation as { ok: true; response: TeamEstimateResponse }).response;
    assert.equal(reponse.blocage, null, JSON.stringify(reponse.blocage));

    const avant = h.fake.requests.length;
    const plan = await preflight.check({ team: equipe, body: corpsLancement(directory, reponse.estimateSha256), mode: "avance", confirmed: false });
    assert.deepEqual(h.fake.requests.slice(avant).map((requete) => `${requete.method} ${requete.pathname}`), [], "le pré-lancement ne lit jamais");
    assert.equal(plan.ok, true, JSON.stringify(plan));
  });

  it("le VRAI déroulé de « Compte rendu d'incident relu » : le plan porte les cinq passages de la relecture, méthode comprise", async (t) => {
    const RELECTEUR = "relecteur-critique";
    const flow = flowDe("postmortem");
    const { h, preflight, directory } = await bancPreflight(t, "Tu rédiges, sans méthode attachée.", [RELECTEUR]);
    const equipe = equipeDe(flow);

    const estimation = await preflight.estimate(equipe, { directory, rootId: null }, "avance");
    assert.equal(estimation.ok, true, JSON.stringify(estimation));
    const reponse = (estimation as { ok: true; response: TeamEstimateResponse }).response;
    assert.equal(reponse.blocage, null, JSON.stringify(reponse.blocage));
    assert.deepEqual(reponse.estimate.repetitions, { tours: 2, specialistes: 0 });

    const plan = await preflight.check({ team: equipe, body: corpsLancement(directory, reponse.estimateSha256), mode: "avance", confirmed: false });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    const etapes = (plan as { ok: true; plan: { etapes: Array<{ stepId: string; assistant: string; agentFileSha256: string | null }> } }).plan.etapes;
    // Chemin maximal d'une relecture à 2 tours : auteur, relecteur, auteur, relecteur, auteur (révision finale).
    assert.deepEqual(etapes.map((etape) => etape.stepId), ["redaction", "relecture", "redaction", "relecture", "redaction"]);
    assert.deepEqual([...new Set(etapes.map((etape) => etape.assistant))], [AUTEUR, RELECTEUR]);
    // Le fichier d'agent a bien été lu et empreinté : c'est de cette lecture que le contexte des méthodes est tiré (A4).
    assert.ok(etapes.every((etape) => typeof etape.agentFileSha256 === "string"), JSON.stringify(etapes.map((e) => e.agentFileSha256)));
    h.assertNoGlobalRestart();
  });
});

// --- 7. Textes des cartes ------------------------------------------------------------------------------------------------------------

describe("L45b : textes des six cartes d'exemple (test « textes »)", () => {
  /** Mots interdits (spécification §2.2 et §2.3) qui pourraient tomber sous la plume dans un exemple d'équipe. */
  const INTERDITS: ReadonlyArray<[string, RegExp]> = [
    ["regard", /(?<![\p{L}\p{N}_-])regards?(?![\p{L}])/iu],
    ["validé", /(?<![\p{L}\p{N}_-])validée?s?(?![\p{L}])/iu],
    ["validation", /(?<![\p{L}\p{N}_-])validations?(?![\p{L}])/iu],
    ["approuvé", /(?<![\p{L}\p{N}_-])approuvée?s?(?![\p{L}])/iu],
    ["modèle", /(?<![\p{L}\p{N}_-])mod[èe]les?(?!\s+de\s+réflexion)(?![\p{L}])/iu],
    ["agent", /(?<![\p{L}\p{N}_-])agents?(?![\p{L}])/iu],
    ["session", /(?<![\p{L}\p{N}_-])sessions?(?![\p{L}])/iu],
    ["prompt", /(?<![\p{L}\p{N}_-])prompts?(?![\p{L}])/iu],
    ["jeton", /(?<![\p{L}\p{N}_-])jetons?(?![\p{L}])/iu],
    ["permission", /(?<![\p{L}\p{N}_-])permissions?(?![\p{L}])/iu],
    ["itération", /(?<![\p{L}\p{N}_-])it[ée]rations?(?![\p{L}])/iu],
    ["réussi", /(?<![\p{L}\p{N}_-])réussie?s?(?![\p{L}])/iu],
    ["feu vert", /(?<![\p{L}\p{N}_-])feux?\s+verts?(?![\p{L}])/iu],
    ["prêt pour le CAB", /(?<![\p{L}\p{N}_-])prête?s?\s+pour\s+le\s+CAB(?![\p{L}])/iu],
    ["sans risque", /(?<![\p{L}\p{N}_-])sans\s+risques?(?![\p{L}])/iu],
    ["chef d'équipe", /(?<![\p{L}\p{N}_-])chefs?\s+d['’]\s*équipes?(?![\p{L}])/iu],
  ];

  const sansMotInterdit = (texte: string, ou: string) => {
    for (const [mot, re] of INTERDITS) assert.equal(re.test(texte), false, `${ou} : « ${mot} » dans « ${texte} »`);
  };

  it("titre, description et liste lue à voix haute de chaque carte : aucun mot interdit", async (t) => {
    const h = await banc(t);
    const cartes: TeamExampleView[] = (await liste(h)).exemples;
    assert.equal(cartes.length, EXEMPLES_C121.length);
    for (const carte of cartes) {
      sansMotInterdit(carte.titre, `${carte.id} (titre)`);
      sansMotInterdit(carte.description, `${carte.id} (description)`);
      for (const ligne of carte.liste) sansMotInterdit(ligne, `${carte.id} (liste)`);
      for (const rangee of carte.layout) {
        for (const cellule of rangee.cellules) {
          sansMotInterdit(cellule.titre, `${carte.id} (schéma)`);
          sansMotInterdit(cellule.sousTitre, `${carte.id} (schéma)`);
        }
      }
      for (const manquant of carte.assistantsManquants) sansMotInterdit(manquant, `${carte.id} (assistants)`);
    }
  });

  it("les consignes envoyées aux IA ne portent pas non plus de mot interdit, et disent « avis » plutôt que « regard »", () => {
    for (const exemple of TEAM_EXAMPLES) {
      for (const etape of toutesLesEtapes(exemple.flow)) {
        sansMotInterdit(etape.titre, `${exemple.id} : ${etape.id} (titre)`);
        sansMotInterdit(etape.consigne, `${exemple.id} : ${etape.id} (consigne)`);
      }
      for (const bloc of exemple.flow.blocs) if (bloc.type === "pause") sansMotInterdit(bloc.message, `${exemple.id} (pause)`);
    }
    // La ligne du contrôle SQL, elle aussi, est relue.
    sansMotInterdit(E5.sqlRepere, "contrôle SQL");
  });
});
