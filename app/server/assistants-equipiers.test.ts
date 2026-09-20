// Tests 1.1 (L45a) : les quatre assistants d'équipe du catalogue et la fiche « postmortem-sans-reproche ».
// Chaque garde a son contrôle discriminant : une entrée sans `role`, avec `task` permis, avec Internet, avec un droit d'écriture,
// sans la liste de contrôle du relecteur ou avec un mot interdit en mode Simple dans ses exemples fait échouer le test.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { AssistantService, assistantDraftSchema } from "./assistants.ts";
import { CATALOGUE, type CatalogueEntry, CATALOGUE_FICHES, REVIEW_BANNER } from "./assistants-catalogue.ts";
import type { ModelCatalog } from "./catalog.ts";
import type { ControlService } from "./control.ts";
import { openMemoryDb } from "./db.ts";
import type { AppEnv } from "./env.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { EventHub } from "./hub.ts";
import type { Ledger } from "./ledger.ts";
import { createLogger } from "./log.ts";
import type { OcLookup } from "./oc-lookup.ts";
import type { OpencodeClient } from "./opencode.ts";
import { ProjectsService } from "./projects.ts";
import { SettingsStore } from "./settings.ts";
import {
  type Action,
  assistantPermission,
  buildAssistantFile,
  type CatalogLite,
  COMMON_RULES_BLOCK,
  DEFAULT_TIERS,
  effectiveAgentRules,
  evaluate,
  ficheSentence,
  OPENCODE_AGENT_KEYS,
  parseModelKey,
  RIGHT_SAMPLES,
  type Rule,
  rulesFromConfig,
  TASK_STEPS,
} from "./shared/assistant-rules.ts";
import { StudioService } from "./studio.ts";
import { TierService } from "./tiers.ts";

/** Identifiants des quatre assistants d'équipe livrés par ce lot, dans l'ordre du catalogue. */
const EQUIPIERS = ["relecteur-critique", "synthese-rapport", "aiguilleur", "rediger-compte-rendu-incident"] as const;

const entree = (id: string): CatalogueEntry => {
  const found = CATALOGUE.find((e) => e.id === id);
  assert.ok(found, `entrée « ${id} » absente du catalogue`);
  return found;
};

const equipiers = (): CatalogueEntry[] => EQUIPIERS.map(entree);

// --- Harnais minimal : service réel sur un dossier temporaire, opencode simulé ------------------------------------------------

const MODELS: CatalogLite[] = [...new Set(Object.values(DEFAULT_TIERS).flatMap((t) => t.candidates))].map((key) => ({
  key,
  providerID: "github-copilot",
  name: parseModelKey(key).modelID,
  variants: ["high"],
  toolcall: true,
  status: "active",
  contextLimit: 200_000,
}));

function harness(t: TestContext) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-equipiers-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const config = path.join(tmp, "oc-config");
  const workspace = path.join(tmp, "workspace");
  fs.mkdirSync(path.join(config, "agents"), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const env = {
    opencodeConfigDir: config,
    workspaceDir: workspace,
    opencodeWorkspaceDir: "/workspace",
    projectConfig: false,
    allowedProviders: ["github-copilot"],
    version: "1.1-test",
  } as AppEnv;
  /** Agents vus par opencode : les fichiers du dossier de configuration, comme le fait GET /agent. */
  const agents = () => {
    const dir = path.join(config, "agents");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".md"))
      .map((file) => {
        const data = parseFrontmatter(fs.readFileSync(path.join(dir, file), "utf8")).data;
        return {
          name: file.slice(0, -3),
          mode: data.mode === "primary" || data.mode === "subagent" ? data.mode : "all",
          ...(typeof data.model === "string" ? { model: parseModelKey(data.model) } : {}),
          ...(typeof data.description === "string" ? { description: data.description } : {}),
          permission: effectiveAgentRules({}, data.permission),
        };
      });
  };
  const client = {
    async request(method: string, pathname: string) {
      if (method === "POST") return true;
      if (pathname === "/global/config") return {};
      if (pathname === "/agent") return agents();
      if (pathname === "/command") return [];
      if (pathname === "/skill") {
        const dir = path.join(config, "skills");
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir).map((name) => ({ name, description: "" }));
      }
      throw new Error(`route inattendue : ${method} ${pathname}`);
    },
  } as unknown as OpencodeClient;
  const log = createLogger("error");
  const db = openMemoryDb();
  t.after(() => db.close());
  const settings = new SettingsStore(db);
  const projects = new ProjectsService(env);
  const control = { restartOpencode: async () => ({ ok: true, durationMs: 0, message: "" }) } as unknown as ControlService;
  const catalog = { loaded: true, lite: () => MODELS, list: () => [] } as unknown as ModelCatalog;
  const studio = new StudioService({ env, client, projects, control, log, catalog });
  const lookup = { get: async () => ({ directory: null, agents: agents(), commands: [], loadedAt: 0 }), invalidate: () => undefined } as unknown as OcLookup;
  const ledger = {
    pricingContext: () => ({ overrides: {}, catalog: new Map(), preferTable: false }),
    estimateAgent: () => null,
  } as unknown as Ledger;
  const tiers = new TierService({ settings, catalog, ledger, env });
  const assistants = new AssistantService({ db, env, client, studio, lookup, tiers, ledger, settings, catalog, projects, hub: new EventHub(), log });
  const meta = (name: string) =>
    db.prepare("SELECT * FROM item_meta WHERE kind = 'agents' AND name = ?").get(name) as unknown as Record<string, unknown> | undefined;
  return { config, assistants, meta };
}

// --- Contrôles réutilisables (chacun trouve son défaut sur une entrée modifiée) ------------------------------------------------

/** Règles opencode d'une entrée, telles que le fichier d'agent les écrira. */
const reglesDe = (entry: CatalogueEntry): Rule[] => rulesFromConfig(assistantPermission(entry.rights, entry.web, entry.fiches));

/** Actions refusées attendues d'un assistant d'équipe : délégation, Internet, écriture et commandes. */
function actionsRefusees(entry: CatalogueEntry): Record<string, Action> {
  const rules = reglesDe(entry);
  return {
    task: evaluate(rules, "task", RIGHT_SAMPLES.task),
    webfetch: evaluate(rules, "webfetch", RIGHT_SAMPLES.webfetch),
    websearch: evaluate(rules, "websearch", RIGHT_SAMPLES.websearch),
    edit: evaluate(rules, "edit", RIGHT_SAMPLES.edit),
    bash: evaluate(rules, "bash", RIGHT_SAMPLES.bash),
  };
}

/** Règles `allow` sur l'édition ou les commandes : aucune n'est attendue. */
const allowsEcriture = (entry: CatalogueEntry): string[] =>
  reglesDe(entry)
    .filter((r) => (r.permission === "edit" || r.permission === "bash") && r.action === "allow")
    .map((r) => `${r.permission} ${r.pattern}`);

/** Problèmes du fichier d'agent construit depuis une entrée (clés inconnues, mode, actions maximum, règles communes, fiches). */
function problemesFichier(entry: CatalogueEntry): string[] {
  const draft = { ...entry, reflection: "standard" as const, model: null };
  const file = buildAssistantFile(draft, { model: "github-copilot/claude-sonnet-5", variant: null });
  const problems: string[] = [];
  for (const key of Object.keys(file.frontmatter)) if (!OPENCODE_AGENT_KEYS.has(key)) problems.push(`clé inconnue d'opencode : ${key}`);
  if (file.frontmatter.mode !== "primary") problems.push("mode différent de primary");
  if (file.frontmatter.steps !== TASK_STEPS[entry.taskSize]) problems.push("actions maximum ≠ taille de la demande");
  if (typeof file.frontmatter.description !== "string" || file.frontmatter.description.trim() === "") problems.push("description vide");
  if (!file.body.includes(COMMON_RULES_BLOCK)) problems.push("règles communes absentes");
  for (const fiche of entry.fiches) if (!file.body.includes(ficheSentence(fiche))) problems.push(`fiche non citée : ${fiche}`);
  if (Object.keys(file.frontmatter).includes("role")) problems.push("role écrit dans le fichier d'agent");
  return problems;
}

// --- Mots interdits (test « textes », spéc. §2.3) sur les textes affichés -----------------------------------------------------

/** Mot ou expression entier, casse ignorée (même forme que `rule` de textes.test.ts). */
const LETTER = "\\p{L}\\p{N}_";
const mot = (nom: string, motif: string) => ({ nom, re: new RegExp(`(?<![${LETTER}-])(?:${motif})(?![${LETTER}])`, "iu") });

/** §2.3 l.102 : interdits en mode Simple. */
const INTERDITS_SIMPLE = [
  mot("agent", "agents?"),
  mot("sous-agent", "sous-agents?"),
  mot("session", "sessions?"),
  mot("prompt", "prompts?"),
  mot("jeton", "jetons?"),
  mot("token", "tokens?"),
  mot("workflow", "workflows?"),
  mot("pipeline", "pipelines?"),
  mot("orchestrateur", "orchestrat(?:eur|rice)s?"),
  mot("nœud", "n(?:œ|oe)uds?"),
  mot("parallèle", "parall[èe]les?"),
  mot("boucle", "boucles?"),
  mot("itération", "it[ée]rations?"),
  mot("permission", "permissions?"),
  mot("juge", "juges?"),
  mot("classifieur", "classifi(?:eur|cateur)s?"),
  mot("LLM", "llms?"),
  mot("profondeur", "profondeurs?"),
  mot("subagent_depth", "subagent_depth"),
  mot("regard", "regards?"),
  mot("validé", "validée?s?"),
  mot("approuvé", "approuvée?s?"),
  mot("vérifié par l'IA", "vérifiée?s?\\s+par\\s+l['’]\\s*IA"),
  mot("feu vert", "feux?\\s+verts?"),
  mot("prêt pour le CAB", "prête?s?\\s+pour\\s+le\\s+CAB"),
];

/** §2.3 l.103 : interdits partout, et §2.2 : bannis partout. */
const INTERDITS_PARTOUT = [
  mot("Toujours autoriser", "toujours\\s+autoriser"),
  mot("jamais plus de", "jamais\\s+plus\\s+de"),
  mot("sans risque", "sans\\s+risques?"),
  mot("tout autoriser", "tout\\s+autoriser"),
  mot("réussi", "réussie?s?"),
  mot("Dossier transmis", "dossiers?\\s+transmis"),
  mot("chef d'équipe", "chefs?\\s+d['’]\\s*équipes?"),
  mot("validation", "validations?"),
  mot("modèle", "mod[èe]les?(?!\\s+de\\s+réflexion)"),
  mot("Réfléchit", "r[ée]fl[ée]chi(?:t|ssent)"),
];

/** Mots interdits trouvés dans un texte affiché en mode Simple. */
const motsInterdits = (texte: string): string[] => [...INTERDITS_SIMPLE, ...INTERDITS_PARTOUT].filter((r) => r.re.test(texte)).map((r) => r.nom);

/** Textes affichés d'une entrée : titre, description et exemples (les consignes partent à l'IA, elles ne s'affichent pas en Simple). */
const textesAffiches = (entry: CatalogueEntry): string[] => [entry.title, entry.description, ...entry.examples];

// --- Tests --------------------------------------------------------------------------------------------------------------------

describe("assistants d'équipe : catalogue (L45a)", () => {
  it("quatre entrées livrées, identifiants uniques, rôle « equipier », lecture seule et sans Internet", () => {
    assert.deepEqual(equipiers().map((e) => e.id), [...EQUIPIERS]);
    assert.deepEqual(
      equipiers().map((e) => [e.id, e.role, e.version, e.rights, e.web, e.examples.length]),
      [
        ["relecteur-critique", "equipier", 1, "lecture", false, 3],
        ["synthese-rapport", "equipier", 1, "lecture", false, 3],
        ["aiguilleur", "equipier", 1, "lecture", false, 3],
        ["rediger-compte-rendu-incident", "equipier", 1, "lecture", false, 3],
      ],
    );
    // Identifiants uniques dans tout le catalogue, et noms de fiches uniques.
    const ids = CATALOGUE.map((e) => e.id);
    assert.deepEqual([...new Set(ids)], ids);
    const fiches = CATALOGUE_FICHES.map((f) => f.name);
    assert.deepEqual([...new Set(fiches)], fiches);
    // Les autres entrées du catalogue restent des assistants ordinaires (aucun rôle posé).
    assert.deepEqual(
      CATALOGUE.filter((e) => !(EQUIPIERS as readonly string[]).includes(e.id)).map((e) => e.role),
      new Array(CATALOGUE.length - EQUIPIERS.length).fill(undefined),
    );
  });

  it("niveaux et tailles tenus : « Relecteur critique » en Rapide (réponse à Q1), les deux rédacteurs en Équilibré", () => {
    assert.deepEqual(
      equipiers().map((e) => [e.id, e.tier, e.taskSize]),
      [
        ["relecteur-critique", "rapide", "S"],
        ["synthese-rapport", "equilibre", "M"],
        ["aiguilleur", "rapide", "S"],
        ["rediger-compte-rendu-incident", "equilibre", "M"],
      ],
    );
  });

  it("chaque entrée donne un brouillon accepté et un fichier d'agent valide, sans `role` dedans", () => {
    for (const entry of equipiers()) {
      const draft = { ...entry, reflection: "standard" } as Record<string, unknown>;
      delete draft.id;
      delete draft.version;
      delete draft.role;
      const parsed = assistantDraftSchema.safeParse(draft);
      assert.equal(parsed.success, true, `${entry.id} : ${JSON.stringify(parsed.error?.issues ?? [])}`);
      assert.deepEqual(problemesFichier(entry), [], entry.id);
    }
    // Contrôle discriminant : `role` laissé dans le brouillon est refusé par le schéma strict.
    const avecRole = { ...entree("aiguilleur"), reflection: "standard" } as Record<string, unknown>;
    delete avecRole.id;
    delete avecRole.version;
    assert.equal(assistantDraftSchema.safeParse(avecRole).success, false);
  });

  it("délégation, Internet, écriture et commandes refusées par evaluate ; aucun `allow` sur edit ni bash", () => {
    const refus = { task: "deny", webfetch: "deny", websearch: "deny", edit: "deny", bash: "deny" };
    for (const entry of equipiers()) {
      assert.deepEqual(actionsRefusees(entry), refus, entry.id);
      assert.deepEqual(allowsEcriture(entry), [], entry.id);
    }
    // Contrôles discriminants : une entrée qui consulte Internet ou qui propose des modifications ne passerait pas.
    const avecWeb = { ...entree("aiguilleur"), web: true };
    assert.equal(actionsRefusees(avecWeb).webfetch, "ask");
    const avecEcriture = { ...entree("aiguilleur"), rights: "propose" as const };
    assert.equal(actionsRefusees(avecEcriture).edit, "ask");
  });

  it("règles communes présentes dans le corps, et chaque fiche citée existe", () => {
    for (const entry of equipiers()) {
      const file = buildAssistantFile({ ...entry, reflection: "standard" }, { model: "github-copilot/claude-sonnet-5", variant: null });
      assert.ok(file.body.includes(COMMON_RULES_BLOCK), entry.id);
      for (const fiche of entry.fiches) assert.ok(CATALOGUE_FICHES.some((f) => f.name === fiche), `${entry.id} : fiche ${fiche}`);
    }
  });

  it("consignes : liste de contrôle du relecteur, sections de chaque équipier et lignes de sortie imposées", () => {
    const relecteur = entree("relecteur-critique").instructions;
    for (const attendu of [
      "Les commandes, les options et les chemins cités existent-ils vraiment",
      "effets irréversibles",
      "retour arrière proposé est-il crédible",
      "donnée client ou un secret a-t-il été recopié",
      "s'appuie-t-elle sur une source",
      "« Points confirmés (avec source) »",
      "« Points à corriger »",
      "« À vérifier par un humain »",
      "Ne conclus jamais d'ensemble et ne donne jamais de « feu vert »",
      "ne la contredit pas",
      "VERDICT:",
    ]) {
      assert.ok(relecteur.includes(attendu), `relecteur-critique : « ${attendu} » absent`);
    }

    const synthese = entree("synthese-rapport").instructions;
    for (const attendu of [
      "« Points d'accord (avis concordants) »",
      "« Points de désaccord »",
      "« Avis manquants »",
      "« Actions proposées »",
      "Cite l'étape source de chaque point",
      "n'est pas une preuve",
    ]) {
      assert.ok(synthese.includes(attendu), `synthese-rapport : « ${attendu} » absent`);
    }

    const aiguilleur = entree("aiguilleur").instructions;
    for (const attendu of ["Ne choisis que dans la liste donnée par l'étape", "une ligne par choix", "« aucun »", "CHOIX:"]) {
      assert.ok(aiguilleur.includes(attendu), `aiguilleur : « ${attendu} » absent`);
    }
    assert.ok(/CHOIX:[^\n]*\n[^\n]*N'écris rien après cette ligne\.$/.test(aiguilleur), "aiguilleur : la ligne CHOIX: ne termine pas la réponse");

    const compteRendu = entree("rediger-compte-rendu-incident").instructions;
    for (const attendu of [
      "Résumé",
      "Impact",
      "Chronologie",
      "Causes",
      "Ce qui a marché",
      "Ce qui n'a pas marché",
      "Actions",
      "rôle responsable",
      "échéance",
      "résultat mesurable",
      "Aucun nom de personne, aucun nom de client",
      "ne désigne jamais de coupable",
      "réponds à chaque point reçu",
    ]) {
      assert.ok(compteRendu.includes(attendu), `rediger-compte-rendu-incident : « ${attendu} » absent`);
    }
  });

  it("textes affichés : aucun mot interdit en mode Simple dans les titres, les descriptions et les exemples", () => {
    for (const entry of equipiers()) {
      for (const texte of textesAffiches(entry)) assert.deepEqual(motsInterdits(texte), [], `${entry.id} : « ${texte} »`);
      for (const exemple of entry.examples) assert.ok(exemple.length <= 200 && exemple.trim() !== "", `${entry.id} : exemple hors bornes`);
    }
    // Contrôle discriminant : les mots interdits sont bien trouvés quand ils sont là.
    assert.deepEqual(motsInterdits("Un second regard validé par l'agent"), ["agent", "regard", "validé"]);
    assert.deepEqual(motsInterdits("Choisissez un modèle"), ["modèle"]);
  });
});

describe("fiche postmortem-sans-reproche (L45a)", () => {
  it("livrée avec le bandeau de relecture, la réponse à l'incident et les trois éléments d'une action", () => {
    const fiche = CATALOGUE_FICHES.find((f) => f.name === "postmortem-sans-reproche");
    assert.ok(fiche, "fiche postmortem-sans-reproche absente");
    assert.ok(fiche.body.startsWith(REVIEW_BANNER), "bandeau de relecture absent en tête");
    assert.ok(fiche.description.trim().length >= 10);
    for (const attendu of [
      "jamais des personnes",
      "L'écart reste écrit",
      "article 13(2)",
      "rapidité de la réponse",
      "escalade",
      "communication",
      "rôle responsable",
      "échéance",
      "résultat mesurable",
      "Chaque fait cite sa source",
      "Chaque hypothèse est marquée",
      "Aucune donnée client",
      "ne désigne pas de coupable",
    ]) {
      assert.ok(fiche.body.includes(attendu), `fiche : « ${attendu} » absent`);
    }
    // Aucun nom de personne ni donnée client en exemple : seulement des repères stables.
    assert.ok(fiche.body.includes("CLIENT_1") && fiche.body.includes("SERVEUR_A"));
    assert.deepEqual(motsInterdits(fiche.description), []);
  });
});

describe("installation d'un assistant d'équipe (L45a)", () => {
  it("installe le fichier et la fiche, écrit item_meta.role = equipier, et list() le rend", async (t) => {
    const h = harness(t);
    const vue = await h.assistants.install("rediger-compte-rendu-incident");
    assert.equal(vue.name, "rediger-compte-rendu-incident");
    assert.equal(vue.origin, "catalogue");
    assert.equal(vue.role, "equipier");
    assert.equal(h.meta("rediger-compte-rendu-incident")?.role, "equipier");

    // Le fichier d'agent ne porte aucune clé « role » : le rôle ne vit que dans item_meta.
    const agent = fs.readFileSync(path.join(h.config, "agents", "rediger-compte-rendu-incident.md"), "utf8");
    const { data, body } = parseFrontmatter(agent);
    assert.equal("role" in data, false);
    assert.ok(body.includes(COMMON_RULES_BLOCK));

    // La fiche livrée est créée avec son bandeau.
    const skill = fs.readFileSync(path.join(h.config, "skills", "postmortem-sans-reproche", "SKILL.md"), "utf8");
    assert.ok(parseFrontmatter(skill).body.trimStart().startsWith(REVIEW_BANNER));

    const liste = await h.assistants.list();
    assert.deepEqual(
      liste.assistants.map((a) => [a.name, a.role]),
      [["rediger-compte-rendu-incident", "equipier"]],
    );
  });

  it("les autres assistants restent « assistant » : catalogue ordinaire installé, puis agent adopté", async (t) => {
    const h = harness(t);
    const installe = await h.assistants.install("expliquer-alerte");
    assert.equal(installe.role, "assistant");
    assert.equal(h.meta("expliquer-alerte")?.role, "assistant");

    fs.writeFileSync(path.join(h.config, "agents", "architecte.md"), "---\ndescription: Conçoit avant de coder.\nmode: primary\n---\nTu es architecte.\n");
    const adopte = await h.assistants.adopt("architecte", { title: "Concevoir avant de coder", useCase: "autre", taskSize: "M" });
    assert.equal(adopte.role, "assistant");

    const liste = await h.assistants.list();
    assert.deepEqual(
      liste.assistants.map((a) => a.role).sort(),
      ["assistant", "assistant"],
    );
  });

  it("le rôle survit à une modification de l'assistant d'équipe installé", async (t) => {
    const h = harness(t);
    const entry = entree("aiguilleur");
    await h.assistants.install("aiguilleur");
    const modifie = await h.assistants.save("aiguilleur", {
      title: "Aiguilleur du réseau",
      description: entry.description,
      useCase: entry.useCase,
      rights: entry.rights,
      web: entry.web,
      tier: entry.tier,
      reflection: "standard",
      taskSize: entry.taskSize,
      instructions: entry.instructions,
      fiches: [...entry.fiches],
      examples: [...entry.examples],
      icon: entry.icon,
      previousName: "aiguilleur",
    });
    assert.equal(modifie.title, "Aiguilleur du réseau");
    assert.equal(modifie.role, "equipier");
    assert.equal(h.meta("aiguilleur")?.role, "equipier");
  });

  it("la vue du catalogue rend le rôle de chaque entrée", async (t) => {
    const h = harness(t);
    const items = await h.assistants.catalogue();
    assert.equal(items.length, CATALOGUE.length);
    assert.deepEqual(
      items.filter((i) => i.role === "equipier").map((i) => i.id),
      [...EQUIPIERS],
    );
    assert.ok(items.filter((i) => i.role === "assistant").length === CATALOGUE.length - EQUIPIERS.length);
  });
});
