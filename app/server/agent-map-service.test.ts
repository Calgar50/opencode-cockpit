// Carte des assistants : route GET /api/agent-map, client web et modèle pur des vues (1.1, itération 4, L39b ; spécification
// §5.2 l.887-892, §5.4 l.911, §5.5, §5.6, §3.9 l.339 ; C §7.4, §9.9 ; plan d'exécution it4, fiche L39b et §4.1.5).
// Ce que ce fichier tient :
// - route : 403 dossier hors du workspace, 400 élément mal formé, 404 sans le module ; profil Prudent (`build` fait travailler
//   `general` et `explore` « après votre accord », sortie de spéc. §7.8 l.1187) ; PARITÉ avec deriveAgentMap sur le faux ;
//   mode Simple sans agents du Studio ; équipes installées → arêtes `etape` ; profondeur lue (absente = 1, 0 traité comme 1) ;
//   AUCUNE ÉCRITURE (base inchangée, aucune requête d'écriture au faux opencode) ;
// - client : une fonction par route de la carte dans api-agent-map.ts, aucune dans api-teams.ts (constat 16), aucun fetch ;
// - modèle pur des colonnes et de la liste (carte-model.ts) : la liste est la VÉRITÉ (une entrée par arête, jamais deux) et
//   `edge.kind` est TOUJOURS passé à phraseArete (correction de contrat du train de V0) ;
// - vues et feuille : aucun texte écrit hors d'agent-map-texts.ts, bloc `forced-colors` avec pointillés, tirets, CanvasText et
//   Highlight, règle d'élément identique à celle du routeur.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import { AGENT_MAP_ELEMENT_RE, profondeurEffective, teamStepsOf } from "./agent-map-service.ts";
import {
  type AgentMapResult,
  deriveAgentMap,
  type MapAgentInput,
  type MapEdge,
  type MapTeamInput,
  mapAsList,
  mapNodeId,
} from "./shared/agent-map.ts";
import { phraseArete, TEXTES } from "./shared/agent-map-texts.ts";
import { builtinAssistantInfo, type UiMode } from "./shared/assistant-rules.ts";
import type { Flow } from "./shared/team-types.ts";
import { INTERNAL_AGENTS, StudioService } from "./studio.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { createTeamStore } from "./team-store.ts";
import {
  aUneIdentite,
  colonnesDe,
  elementMontre,
  groupesDuSelecteur,
  iaDuNoeud,
  nomDuNoeud,
  notesSousLaCarte,
  phrasesEtatVide,
  sectionsDeLaListe,
  traitArete,
} from "../web/pages/assistants/carte/carte-model.ts";

const APP = path.join(import.meta.dirname, "..");
const CARTE = path.join(APP, "web", "pages", "assistants", "carte");
const lire = (relatif: string) => fs.readFileSync(path.join(APP, relatif), "utf8");
const P = TEXTES.partout;
const A = (name: string) => mapNodeId("agent", name);
const E = (id: string) => mapNodeId("equipe", id);

/** Harnais avec le seul module de la carte : les autres modules d'équipes gardent leurs ports neutres (plan §2.3). */
const carte = (t: TestContext, options: Parameters<typeof startCockpit>[1] = {}) => startCockpit(t, { ...options, equipes: ["agentMap"] });

async function lireCarte(h: CockpitHarness, query = `?directory=${encodeURIComponent(h.fake.directory)}`): Promise<{ status: number; body: AgentMapResult }> {
  const res = await h.call("GET", `/api/agent-map${query}`, { headers: h.headers.authed });
  return { status: res.status, body: res.json<AgentMapResult>() };
}

/** Contenu complet de la base, pour prouver qu'une lecture n'écrit rien (noms de tables lus dans le schéma, jamais reçus). */
function contenuBase(db: DatabaseSync): string {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as unknown as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => /^[A-Za-z0-9_]+$/.test(name));
  return JSON.stringify(tables.map((name) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
}

/**
 * Même carte, dérivée dans le test à partir du faux opencode : c'est la PARITÉ demandée par la fiche (la route ne doit rien
 * ajouter ni retrancher au module pur de L39a). Les agents du faux n'ont pas d'IA propre : la ligne d'IA est testée à part.
 */
function attendu(h: CockpitHarness, options: { mode?: UiMode; fiches?: string[]; equipes?: MapTeamInput[]; depth?: number } = {}): AgentMapResult {
  const agents: MapAgentInput[] = h.fake.agents().map((agent) => ({
    name: agent.name,
    mode: agent.mode,
    hidden: agent.hidden,
    rules: agent.permission,
    origine: agent.native === true ? "integre" : "studio",
    titre: agent.name === "build" || agent.name === "plan" ? builtinAssistantInfo(agent.name, agent.permission).title : null,
    ia: null,
    steps: agent.steps ?? null,
  }));
  const mode = options.mode ?? "simple";
  return deriveAgentMap({
    agents: mode === "simple" ? agents.filter((agent) => agent.origine !== "studio") : agents,
    commands: h.fake.commands().map((command) => ({
      name: command.name,
      agent: command.agent,
      subtask: command.subtask,
      source: command.source,
      titre: null,
      ia: null,
    })),
    fiches: options.fiches ?? [],
    equipes: options.equipes ?? [],
    subagentDepth: options.depth ?? 1,
    mode,
    internes: INTERNAL_AGENTS,
  });
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Déroulé d'essai : une étape, puis un bloc d'avis (deux avis et une synthèse) — quatre étapes dans l'ordre de planSteps. */
function flowEssai(): Flow {
  const etape = (id: string, assistant: string, niveau: "rapide" | null = null) => ({
    id,
    titre: `Étape ${id}`,
    assistant,
    niveau,
    taille: "M" as const,
    consigne: "",
    recoit: "demande" as const,
  });
  return {
    version: 1,
    blocs: [
      { type: "etape", id: "b1", etape: etape("a1", "relire") },
      { type: "pause", id: "b2", message: "" },
      { type: "avis", id: "b3", avis: [etape("r1", "relire", "rapide"), etape("r2", "verifier")], synthese: etape("s1", "relire") },
    ],
  };
}

describe("carte des assistants : route GET /api/agent-map (L39b)", () => {
  it("sans module d'équipes : la route n'existe pas (404), comme avant l'itération 4", async (t) => {
    const h = await startCockpit(t);
    const res = await h.call("GET", `/api/agent-map?directory=${encodeURIComponent(h.fake.directory)}`, { headers: h.headers.authed });
    assert.equal(res.status, 404);
  });

  it("dossier hors du workspace monté : 403 forbidden-directory, avec la phrase de T4t", async (t) => {
    const h = await carte(t);
    for (const directory of ["/etc", `${h.fake.directory}/../etc`]) {
      const res = await h.call("GET", `/api/agent-map?directory=${encodeURIComponent(directory)}`, { headers: h.headers.authed });
      assert.equal(res.status, 403, directory);
      assert.deepEqual(res.json(), { error: "forbidden-directory", message: P.erreurs["forbidden-directory"] }, directory);
    }
    assert.equal((await lireCarte(h)).status, 200, "le dossier du workspace passe");
    assert.equal((await lireCarte(h, "")).status, 200, "sans dossier : instance par défaut");
  });

  it("élément mal formé : 400 invalid ; identifiant de nœud accepté ; même règle que l'adresse de l'interface", async (t) => {
    const h = await carte(t);
    for (const element of ["Build", "agent:", "a/b", "relire-script", "fiche:<script>", `agent:${"a".repeat(80)}`]) {
      const res = await h.call("GET", `/api/agent-map?element=${encodeURIComponent(element)}`, { headers: h.headers.authed });
      assert.equal(res.status, 400, element);
      assert.deepEqual(res.json(), { error: "invalid", message: P.erreurs.invalid }, element);
    }
    for (const element of ["vous", "agent:build", "raccourci:revue", "fiche:relire", "equipe:relecture-sql"]) {
      const res = await h.call("GET", `/api/agent-map?element=${encodeURIComponent(element)}`, { headers: h.headers.authed });
      assert.equal(res.status, 200, element);
    }
    // La route et #/assistants/carte?element=… acceptent exactement les mêmes valeurs : une seule règle, écrite deux fois.
    const routeur = /const CARTE_ELEMENT_ID = (\/.+\/);/.exec(lire("web/lib/router.ts"));
    assert.ok(routeur, "règle d'élément du routeur trouvée");
    assert.equal(routeur[1], AGENT_MAP_ELEMENT_RE.toString());
  });

  it("profil Prudent : `build` fait travailler `general` et `explore` « après votre accord » (spéc. §7.8 l.1187)", async (t) => {
    const h = await carte(t, { settings: { ui: { mode: "avance" } } });
    const { body } = await lireCarte(h);
    const depuisBuild = body.edges.filter((edge) => edge.kind === "delegue" && edge.from === A("build"));
    assert.deepEqual(
      depuisBuild.map((edge) => [edge.to, edge.confirmation, edge.code, edge.appliquePar]),
      [
        [A("explore"), "demandee", "delegue-apres-accord", "opencode"],
        [A("general"), "demandee", "delegue-apres-accord", "opencode"],
      ],
    );
    // Aucun agent interne d'opencode dans la carte (compaction, title, summary).
    assert.deepEqual(
      body.nodes.filter((node) => ["compaction", "title", "summary"].includes(node.name)),
      [],
    );
  });

  it("parité : la route rend exactement deriveAgentMap sur les agents et raccourcis du faux (les deux modes)", async (t) => {
    const h = await carte(t);
    h.fake.setCommands([
      { name: "revue", template: "Relis $ARGUMENTS", hints: [], agent: "general", subtask: true },
      { name: "resume", template: "Résume $ARGUMENTS", hints: [], agent: "build" },
      { name: "mcp-outil", template: "x", hints: [], source: "mcp" },
    ]);
    assert.deepEqual(clone((await lireCarte(h)).body), clone(attendu(h, { mode: "simple" })));
    h.settings.update({ ui: { mode: "avance" } });
    assert.deepEqual(clone((await lireCarte(h)).body), clone(attendu(h, { mode: "avance" })));
  });

  it("mode Simple : aucun agent du Studio ni ses arêtes ; mode Avancé : il est là, avec le mot d'opencode", async (t) => {
    const h = await carte(t);
    const natifs = h.fake.agents();
    h.fake.setAgents([...natifs, { name: "outil-studio", mode: "all", options: {}, permission: natifs[0]?.permission ?? [] }]);
    const simple = (await lireCarte(h)).body;
    assert.equal(
      simple.nodes.some((node) => node.name === "outil-studio"),
      false,
    );
    assert.equal(
      simple.edges.some((edge) => edge.from === A("outil-studio") || edge.to === A("outil-studio")),
      false,
      "aucune arête d'un agent retiré",
    );
    h.settings.update({ ui: { mode: "avance" } });
    const avance = (await lireCarte(h)).body;
    const studio = avance.nodes.find((node) => node.name === "outil-studio");
    assert.ok(studio);
    assert.equal(studio.kind, "agent-studio");
    assert.equal(TEXTES.avance.genres["agent-studio"], "Agent du Studio");
  });

  it("un assistant du cockpit (item_meta) est un assistant, pas un agent du Studio ; son titre vient de la base", async (t) => {
    const h = await carte(t, { settings: { ui: { mode: "avance" } } });
    const natifs = h.fake.agents();
    h.fake.setAgents([...natifs, { name: "relire", mode: "all", options: {}, permission: natifs[0]?.permission ?? [] }]);
    h.db
      .prepare("INSERT INTO item_meta (kind, name, title, task_size, origin, created_at, updated_at) VALUES ('agents', 'relire', 'Relire un script', 'M', 'assistant', 0, 0)")
      .run();
    const node = (await lireCarte(h)).body.nodes.find((n) => n.name === "relire");
    assert.ok(node);
    assert.equal(node.kind, "assistant");
    assert.equal(node.title, "Relire un script");
    assert.equal((await lireCarte(h)).body.nodes.find((n) => n.name === "build")?.title, builtinAssistantInfo("build").title);
  });

  it("équipes installées : une arête `etape` par étape, dans l'ordre ; fermées en mode Simple tant que la constante est fausse", async (t) => {
    const h = await carte(t, { settings: { ui: { mode: "avance" } } });
    const natifs = h.fake.agents();
    const regles = natifs[0]?.permission ?? [];
    h.fake.setAgents([
      ...natifs,
      { name: "relire", mode: "all", options: {}, permission: regles },
      { name: "verifier", mode: "all", options: {}, permission: regles },
    ]);
    createTeamStore({ db: h.db }).teams.put({
      id: "relecture-sql",
      titre: "Relecture SQL",
      description: "",
      flow: flowEssai(),
      origine: "exemple",
      avance: false,
    });

    const avance = (await lireCarte(h)).body;
    const equipe = avance.nodes.find((node) => node.id === E("relecture-sql"));
    assert.ok(equipe);
    assert.equal(equipe.title, "Relecture SQL");
    assert.deepEqual(
      avance.edges.filter((edge) => edge.kind === "etape").map((edge) => [edge.to, edge.etape?.numero, edge.etape?.niveau, edge.appliquePar, edge.code]),
      // Arêtes rangées par cible (nom) puis par rang d'étape : les trois étapes de « relire », puis celle de « verifier ».
      [
        [A("relire"), 1, null, "cockpit", "etape-imposee"],
        [A("relire"), 2, "rapide", "cockpit", "etape-imposee"],
        [A("relire"), 4, null, "cockpit", "etape-imposee"],
        [A("verifier"), 3, null, "cockpit", "etape-imposee"],
      ],
    );
    // L'arête « Vous → équipe » est émise pour toute équipe passée en entrée (report MX-EQ §4.2).
    assert.ok(avance.edges.some((edge) => edge.from === "vous" && edge.to === E("relecture-sql") && edge.appliquePar === "cockpit"));

    h.settings.update({ ui: { mode: "simple" } });
    const simple = (await lireCarte(h)).body;
    assert.deepEqual(simple.nodes.filter((node) => node.kind === "equipe"), []);
    assert.deepEqual(simple.edges.filter((edge) => edge.kind === "etape"), []);
  });

  it("déroulé illisible ou étape d'un assistant absent : aucune arête d'étape, jamais d'exception", async (t) => {
    assert.deepEqual(teamStepsOf("{pas du json"), []);
    assert.deepEqual(teamStepsOf(JSON.stringify({ version: 1 })), []);
    assert.deepEqual(teamStepsOf(JSON.stringify(flowEssai())), [
      { assistant: "relire", niveau: null },
      { assistant: "relire", niveau: "rapide" },
      { assistant: "verifier", niveau: null },
      { assistant: "relire", niveau: null },
    ]);
    const h = await carte(t, { settings: { ui: { mode: "avance" } } });
    createTeamStore({ db: h.db }).teams.put({ id: "orpheline", titre: "Orpheline", description: "", flow: flowEssai(), origine: "creee", avance: false });
    const body = (await lireCarte(h)).body;
    assert.ok(body.nodes.some((node) => node.id === E("orpheline")), "l'équipe reste dans la carte");
    assert.deepEqual(body.edges.filter((edge) => edge.kind === "etape"), [], "aucune étape vers un assistant absent");
  });

  it("profondeur : absente = 1 ; 0 traité comme 1 (report MX-EQ §4.2) ; illisible lève, l'appelant retombe sur 1", () => {
    // Le 0 d'opencode ne se voit pas dans la carte dérivée (deriveAgentMap ne compare qu'à 1) : la normalisation se teste ici.
    assert.equal(profondeurEffective({}), 1, "absente = défaut d'opencode");
    assert.equal(profondeurEffective({ subagent_depth: 0 }), 1, "0 traité comme 1");
    assert.equal(profondeurEffective(null), 1, "configuration illisible = défaut");
    assert.equal(profondeurEffective({ subagent_depth: 2 }), 2);
    assert.equal(profondeurEffective({ experimental: { subagent_depth: 3 } }), 3, "emplacement historique lu comme au Diagnostic");
    assert.throws(() => profondeurEffective({ subagent_depth: "deux" }), /subagent_depth/);
  });

  it("profondeur : absente = 1 ; > 1 en Avancé seulement ; 0 traité comme 1 ; illisible = 1", async (t) => {
    const h = await carte(t, { settings: { ui: { mode: "avance" } } });
    assert.equal(h.fake.globalConfig.subagent_depth, undefined);
    assert.ok((await lireCarte(h)).body.notes.includes("profondeur-un"));

    h.fake.globalConfig.subagent_depth = 2;
    assert.ok((await lireCarte(h)).body.notes.includes("profondeur-plus"), "profondeur lue dans GET /global/config");
    h.settings.update({ ui: { mode: "simple" } });
    const simple = (await lireCarte(h)).body;
    assert.equal(simple.notes.includes("profondeur-plus"), false, "aucune mention de profondeur en mode Simple (§5.2 l.891)");

    h.settings.update({ ui: { mode: "avance" } });
    for (const valeur of [0, "deux"]) {
      h.fake.globalConfig.subagent_depth = valeur;
      const body = (await lireCarte(h)).body;
      assert.ok(body.notes.includes("profondeur-un"), `subagent_depth ${String(valeur)} → 1`);
      assert.equal(body.notes.includes("profondeur-plus"), false, String(valeur));
    }
  });

  it("fiches : mêmes noms que le Studio, et une arête `consulte` par fiche lisible", async (t) => {
    // Studio RÉEL (le harnais n'en simule que l'écriture) : la carte lit les mêmes fichiers que la page Assistants.
    const h = await carte(t, {
      settings: { ui: { mode: "avance" } },
      deps: (base) => ({ studio: new StudioService({ env: base.env, client: base.client, projects: base.projects, control: base.control, log: base.log }) }),
    });
    const dossier = path.join(h.deps.env.opencodeConfigDir, "skills", "requetes-sql-sures");
    fs.mkdirSync(dossier, { recursive: true });
    fs.writeFileSync(path.join(dossier, "SKILL.md"), "---\ndescription: Fiche d'essai\n---\nCorps.\n");
    const body = (await lireCarte(h)).body;
    assert.deepEqual(
      body.nodes.filter((node) => node.kind === "fiche").map((node) => node.name),
      ["requetes-sql-sures"],
    );
    assert.ok(body.edges.some((edge) => edge.kind === "consulte" && edge.from === A("build") && edge.code === "consulte-fiche"));
  });

  it("aucune écriture : base inchangée et, vers opencode, que des lectures", async (t) => {
    const h = await carte(t, { settings: { ui: { mode: "avance" } } });
    createTeamStore({ db: h.db }).teams.put({ id: "eq", titre: "Équipe", description: "", flow: flowEssai(), origine: "creee", avance: false });
    const avant = contenuBase(h.db);
    const depuis = h.fake.requests.length;
    assert.equal((await lireCarte(h)).status, 200);
    assert.equal((await lireCarte(h, "?element=agent%3Abuild")).status, 200);
    assert.equal(contenuBase(h.db), avant, "la carte n'écrit rien en base");
    const faites = h.fake.requests.slice(depuis);
    assert.deepEqual(
      [...new Set(faites.map((req) => req.method))].sort(),
      ["GET"],
      `requêtes : ${JSON.stringify(faites.map((req) => `${req.method} ${req.pathname}`))}`,
    );
    h.assertNoGlobalRestart();
  });
});

describe("carte des assistants : client web (api-agent-map.ts, constat 16)", () => {
  it("une fonction par route de la carte, ici et nulle part ailleurs ; aucun appel réseau écrit à la main", () => {
    const source = lire("web/lib/api-agent-map.ts");
    const methods: Record<string, string> = { get: "GET", post: "POST", put: "PUT", del: "DELETE" };
    const appels = [...source.matchAll(/http\.(get|post|put|del)<[^>]*>\(\s*[`"]([^`"]+)[`"]/g)].map(
      (m) => `${methods[m[1] ?? ""]} ${(m[2] ?? "").replace(/\$\{query\(\{[^}]*\}\)\}/g, "")}`,
    );
    assert.deepEqual(appels, ["GET /api/agent-map"]);
    assert.equal(/\bfetch\s*\(/.test(source), false, "CSRF et erreurs par l'aide http de web/lib/api.ts");
    assert.equal(/x-cockpit-csrf/i.test(source), false);
    // Le client de la carte n'est pas dans api-teams.ts (test de T4, repris ici du côté de la carte).
    assert.equal(/agent-map/.test(lire("web/lib/api-teams.ts").replace(/^\/\/.*$/gm, "")), false);
    // Les vues de la carte passent par ce client, jamais par api-teams.ts ni par fetch.
    for (const fichier of fs.readdirSync(CARTE)) {
      if (!/\.tsx?$/.test(fichier)) continue;
      const texte = fs.readFileSync(path.join(CARTE, fichier), "utf8");
      assert.equal(/\bfetch\s*\(/.test(texte), false, fichier);
      assert.equal(/api-teams\.ts/.test(texte), false, fichier);
    }
  });
});

describe("carte des assistants : modèle pur des colonnes et de la liste (carte-model.ts)", () => {
  /** Carte d'essai : Vous, deux assistants intégrés, un raccourci sous-tâche, un raccourci simple, une fiche et une équipe. */
  async function exemple(t: TestContext): Promise<AgentMapResult> {
    const h = await carte(t, { settings: { ui: { mode: "avance" } } });
    const natifs = h.fake.agents();
    h.fake.setAgents([...natifs, { name: "relire", mode: "all", options: {}, permission: natifs[0]?.permission ?? [] }]);
    h.fake.setCommands([
      { name: "revue", template: "x", hints: [], agent: "general", subtask: true },
      { name: "resume", template: "x", hints: [], agent: "relire" },
    ]);
    createTeamStore({ db: h.db }).teams.put({ id: "eq", titre: "Relecture", description: "", flow: flowEssai(), origine: "creee", avance: false });
    return (await lireCarte(h)).body;
  }

  it("la liste est la VÉRITÉ : une entrée par arête, jamais deux, et chaque entrée a sa phrase", async (t) => {
    const result = await exemple(t);
    const sections = sectionsDeLaListe(result, true);
    assert.equal(
      sections.reduce((total, section) => total + section.liens.length, 0),
      result.edges.length,
    );
    assert.equal(mapAsList(result).reduce((total, section) => total + section.entries.length, 0), result.edges.length);
    for (const section of sections) for (const lien of section.liens) assert.notEqual(lien.phrase, "", `${section.node.id} → ${lien.id}`);
  });

  it("`edge.kind` est toujours passé à phraseArete : un raccourci qui n'est pas une sous-tâche ne dit pas la phrase de Vous", async (t) => {
    const result = await exemple(t);
    const liens = sectionsDeLaListe(result, true).flatMap((section) => section.liens);
    const lance = liens.filter((lien) => lien.kind === "lance");
    assert.equal(lance.length, 2, "deux raccourcis mènent à un assistant");
    const phrases = lance.map((lien) => lien.phrase).sort();
    assert.ok(
      phrases.includes(P.raccourciFaitRepondre.replace("{source}", "resume").replace("{cible}", "relire")),
      `« fait répondre » attendu : ${JSON.stringify(phrases)}`,
    );
    assert.ok(
      phrases.includes(P.aretes["raccourci-sans-confirmation"].replace("{source}", "revue").replace("{cible}", "general")),
      `sous-tâche attendue : ${JSON.stringify(phrases)}`,
    );
    assert.equal(
      liens.some((lien) => lien.kind === "lance" && lien.phrase === P.aretes.utilise.replace("{cible}", "relire")),
      false,
      "la phrase de Vous ne sert jamais à un raccourci",
    );
    // Contrôle discriminant du contrat : sans le genre, la même arête rendrait la phrase de Vous.
    assert.equal(phraseArete("utilise", "resume", "relire", "aucune"), "Vous pouvez utiliser « relire » dans le chat.");
    assert.equal(phraseArete("utilise", "resume", "relire", "aucune", "lance"), "Le raccourci « resume » fait répondre « relire » dans la conversation (règle d'opencode).");
  });

  it("colonnes de la vue Centrée : les voisins de l'élément, avec les mêmes phrases que la liste", async (t) => {
    const result = await exemple(t);
    const colonnes = colonnesDe(result, A("relire"), true);
    assert.ok(colonnes);
    const attendues = result.edges.filter((edge) => edge.to === A("relire")).length;
    assert.equal(colonnes.amont.length, attendues);
    assert.equal(colonnes.aval.length, result.edges.filter((edge) => edge.from === A("relire")).length);
    const phrasesListe = new Set(sectionsDeLaListe(result, true).flatMap((section) => section.liens.map((lien) => lien.phrase)));
    for (const lien of [...colonnes.amont, ...colonnes.aval]) assert.ok(phrasesListe.has(lien.phrase), lien.phrase);
    assert.equal(colonnesDe(result, "agent:inconnu", true), null);
  });

  it("trait d'une arête : le cockpit d'abord, puis la demande d'accord ; chaque trait a son MOT de la légende", () => {
    const edge = (patch: Partial<MapEdge>): MapEdge => ({
      from: "vous",
      to: A("x"),
      kind: "delegue",
      confirmation: "sans",
      appliquePar: "opencode",
      refuseEnSimple: false,
      code: "delegue-sans-confirmation",
      ...patch,
    });
    assert.equal(traitArete(edge({})), "sans");
    assert.equal(traitArete(edge({ confirmation: "demandee" })), "accord");
    assert.equal(traitArete(edge({ appliquePar: "cockpit" })), "impose");
    assert.equal(traitArete(edge({ confirmation: "demandee", appliquePar: "cockpit", refuseEnSimple: true })), "impose");
    assert.equal(traitArete(edge({ confirmation: "aucune" })), null);
    assert.deepEqual([P.legende.sans, P.legende.accord, P.legende.impose], ["sans confirmation", "après votre accord", "imposé par le cockpit"]);
  });

  it("mode Simple : la phrase d'une délégation demandée dit que le cockpit refuse et que l'IA continue seule", async (t) => {
    const h = await carte(t);
    const refusee = (await lireCarte(h)).body.edges.find((edge) => edge.code === "delegue-refuse-en-simple");
    assert.ok(refusee, "une délégation demandée existe sous le profil Prudent");
    assert.equal(refusee.refuseEnSimple, true);
    assert.equal(traitArete(refusee), "impose");
    const phrase = phraseArete(refusee.code, "build", "general", refusee.confirmation, refusee.kind);
    assert.ok(phrase?.includes(P.refuseEnSimple), phrase ?? "");
  });

  it("élément montré, sélecteur, identité, IA et notes", async (t) => {
    const result = await exemple(t);
    assert.equal(elementMontre(result, "agent:relire"), A("relire"));
    assert.equal(elementMontre(result, "agent:inconnu"), "vous", "un élément inconnu ne vide jamais la vue");
    assert.equal(elementMontre(result, null), "vous");
    assert.equal(elementMontre({ nodes: [], edges: [], notes: [] }, null), null);

    const groupes = groupesDuSelecteur(result, true);
    assert.deepEqual(
      groupes.map((groupe) => groupe.titre),
      [null, P.groupes.raccourcis, P.groupes.equipes, P.groupes.assistants],
    );
    assert.deepEqual(groupes[0]?.options, [{ id: "vous", nom: "Vous" }], "« Vous » vient en tête, sans groupe");
    const cherche = groupesDuSelecteur(result, true, "RELEC");
    assert.deepEqual(cherche.flatMap((groupe) => groupe.options.map((option) => option.id)), [E("eq")]);

    const relire = result.nodes.find((node) => node.id === A("relire"));
    const vous = result.nodes.find((node) => node.id === "vous");
    assert.ok(relire);
    assert.ok(vous);
    assert.equal(aUneIdentite(relire), true);
    assert.equal(aUneIdentite(vous), false, "« Vous » n'a pas de carte d'identité");
    assert.equal(nomDuNoeud(vous, true), "Vous");
    assert.equal(iaDuNoeud(relire), P.ia.conversation, "sans IA propre : celle choisie dans le chat");

    assert.deepEqual(notesSousLaCarte(result).at(-1), P.notes["regles-pas-historique"]);
    assert.equal(notesSousLaCarte(result).includes(P.notes["ia-du-delegant"]), false, "la ligne d'IA d'un nœud ne se répète pas dessous");
    assert.deepEqual(phrasesEtatVide(result), []);
  });

  it("états vides (§5.4 l.911) : aucun assistant installé, aucun lien entre assistants", () => {
    const vide: AgentMapResult = { nodes: [], edges: [], notes: ["aucun-assistant", "aucun-lien", "regles-pas-historique"] };
    assert.deepEqual(phrasesEtatVide(vide), [
      "Aucun assistant installé : seul l'Assistant général travaille.",
      "Aucun assistant ne peut en faire travailler un autre.",
    ]);
    assert.deepEqual(notesSousLaCarte(vide), [P.notes["regles-pas-historique"]]);
  });
});

describe("carte des assistants : vues et feuille (L39b)", () => {
  const fichiers = () => fs.readdirSync(CARTE).filter((nom) => /\.tsx?$/.test(nom));

  it("aucun texte écrit dans les vues : tout vient d'agent-map-texts.ts", () => {
    const sansBruit = (texte: string) =>
      texte
        .split("\n")
        .filter((ligne) => !/^\s*(\/\/|\*|\/\*)/.test(ligne) && !/\bconsole\./.test(ligne))
        .join("\n");
    const suspect = (valeur: string) => /\s/.test(valeur) && (/[À-ÿ]/.test(valeur) || /[A-ZÀ-Ý][a-zà-ÿ]/.test(valeur));
    for (const nom of fichiers()) {
      const code = sansBruit(fs.readFileSync(path.join(CARTE, nom), "utf8"));
      const litteraux = [...code.matchAll(/"([^"\n]*)"/g)].map((m) => m[1] ?? "").filter(suspect);
      assert.deepEqual(litteraux, [], `${nom} : texte écrit hors d'agent-map-texts.ts`);
      assert.ok(suspect("Nouvel assistant"), "contrôle discriminant");
    }
    // Les phrases d'arête passent toutes par le modèle pur, qui ajoute edge.kind : aucune vue n'appelle phraseArete elle-même.
    for (const nom of fichiers().filter((fichier) => fichier.endsWith(".tsx"))) {
      assert.equal(/\bphraseArete\s*\(/.test(fs.readFileSync(path.join(CARTE, nom), "utf8")), false, nom);
    }
    assert.match(fs.readFileSync(path.join(CARTE, "carte-model.ts"), "utf8"), /phraseArete\([\s\S]{0,200}?edge\.kind\)/);
  });

  it("carte.css : contraste forcé (U9) — connecteurs en CanvasText, pointillés, tirets, nœud choisi bordé, focus Highlight", () => {
    const css = fs.readFileSync(path.join(CARTE, "carte.css"), "utf8");
    const debut = css.indexOf("@media (forced-colors: active)");
    assert.ok(debut > 0, "bloc de contraste forcé présent");
    const bloc = css.slice(debut);
    assert.match(bloc, /\.ca-connecteur-trait,\s*\n\s*\.ca-connecteur-pointe \{\s*\n\s*stroke: CanvasText;/);
    assert.match(bloc, /\.ca-lien\.ca-trait-accord \{\s*\n\s*border-left-style: dotted;/);
    assert.match(bloc, /\.ca-lien\.ca-trait-impose \{\s*\n\s*border-left-style: dashed;/);
    assert.match(bloc, /\.ca-section\.choisi/);
    assert.match(bloc, /outline: 2px solid Highlight;/);
    // Hors contraste forcé, les mêmes formes portent déjà le sens : la couleur n'est jamais seule.
    const avant = css.slice(0, debut);
    assert.match(avant, /\.ca-lien\.ca-trait-accord \{\s*\n\s*border-left-style: dotted;/);
    assert.match(avant, /\.ca-lien\.ca-trait-impose \{\s*\n\s*border-left-style: dashed;/);
    // Les DEUX connecteurs à confirmation ont leur propre forme de trait : sans elles, la couleur porterait le sens seule.
    assert.match(avant, /\.ca-connecteur-trait\.ca-trait-accord \{\s*\n\s*stroke-dasharray: [\d ]+;/);
    assert.match(avant, /\.ca-connecteur-trait\.ca-trait-impose \{\s*\n\s*stroke-dasharray: [\d ]+;/);
    // Aucune animation, aucune transition DÉCLARÉE : rien à placer sous prefers-reduced-motion (commentaires ignorés).
    assert.equal(/\banimation\b|\btransition\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, "")), false);
  });

  it("l'onglet remplace le squelette de T4w : propriétés figées, liste toujours rendue, « Vue d'ensemble » non annoncée", () => {
    const tab = fs.readFileSync(path.join(CARTE, "CarteTab.tsx"), "utf8");
    assert.equal((tab.split("\n")[0] ?? "").replace(/\r$/, ""), "// Propriétaire : L39b.");
    assert.equal(tab.includes("Squelette T4w"), false);
    assert.match(tab, /export function CarteTab\(\{ directory, advanced, element \}: CarteTabProps\)/);
    assert.match(tab, /<CarteListe result=\{data\} advanced=\{advanced\} element=\{montre\} onChoisir=\{choisir\} \/>/);
    assert.match(tab, /<CarteCentree result=\{data\} advanced=\{advanced\} element=\{montre\} onChoisir=\{choisir\} \/>/);
    assert.equal(/ensemble/i.test(tab.replace(/^\s*\/\/.*$/gm, "")), false, "« Vue d'ensemble » arrive en itération 5 (P3)");
    // Connecteurs SVG décoratifs : jamais lus, jamais focalisables (§5.2).
    const centree = fs.readFileSync(path.join(CARTE, "CarteCentree.tsx"), "utf8");
    assert.match(centree, /<svg className="ca-connecteur"[^>]*aria-hidden="true" focusable="false" role="presentation">/);
  });
});
