// Tests L20 : audit d'Oh My OpenAgent 4.19.4, énumérations, décisions par hook et par clé, rôles.
// (spécification §3.15.1 l.477-492, §3.7 l.308, §4.10 l.759, §5.7.3 l.970, G12 l.1226, JS-3, JS-9, M28 l.1296 ;
//  plan d'exécution D-2b-10, D-2b-31, D-2b-47, fiche L20.)
//
// - T-L20-a : faux opencode, `GET /agent` = table d'audit → aucun écart ; un `allow` en vigueur hors table, un fichier de clés
//   autorisé, un agent inconnu ou un agent coupé toujours présent → échec (porte G12). Les agents servis au faux sont ceux qu'opencode
//   rend dans la salle : « * * allow » en tête, la dernière règle qui correspond l'emporte, agents natifs compris ;
// - T-L20-c : rôle par clé de configuration ; `athena` et `council-member` → « autres » ;
// - T-L20-d : pureté des trois modules partagés ;
// - T-L20-e : tableau « Ce que l'extension fait sans demande » engendré depuis la table, jamais écrit à la main ;
// - énumérations exactes (56 hooks dont `goal`, sans `ralph-loop`), décision pour chaque nom, valeurs épinglées de D-2b-47 ;
// - `docker/opencode-omo/enums-4.19.4.json` égal à la table machine ;
// - document et table cohérents, document sans bloc de code ni ligne de plus de 200 caractères (D-2b-31).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { type AgentLite, effectiveAgentRules, type Rule, rulesFromConfig, truncateGlob } from "./shared/assistant-rules.ts";
import {
  AGENTS,
  AGENTS_OPENCODE,
  AUTORISATIONS_OPENCODE,
  CLES,
  COMMANDES,
  COMPETENCES,
  compareAgentsToAudit,
  DISQUE,
  enumerations,
  FOURNISSEURS_COUPES,
  HOOKS,
  MCPS,
  type OmoAgentAudit,
  type OmoEcartAgent,
  type OmoHookAudit,
  type OmoOutilAudit,
  OMO_VERSION,
  OUTILS,
  OUTILS_A_COUPER,
  PERMISSIONS_POSEES,
  PERMISSIONS_SENSIBLES,
  PERMISSIONS_SONDEES,
  RESEAU,
  SONDES_FICHIERS_DE_CLES,
  valeursEpinglees,
} from "./shared/omo-audit-4.19.4.ts";
import { formatVersionAuditee, tableauSansDemande, TEXTES } from "./shared/omo-audit-texts.ts";
import { CLES_AGENTS, OMO_ROLES, roleDeAgent } from "./shared/omo-roles.ts";
import { FakeOpencode, type FakeAgent, nativeAgents } from "./test-support/fake-opencode.ts";

const SERVER_DIR = import.meta.dirname;
const RACINE = path.join(SERVER_DIR, "..", "..");
const DOC = path.join(RACINE, "docs", "omo-audit-4.19.4.md");
const ENUMS = path.join(RACINE, "docker", "opencode-omo", "enums-4.19.4.json");

const lire = (fichier: string) => fs.readFileSync(fichier, "utf8");
const noms = <T extends { nom: string }>(entrees: readonly T[]) => entrees.map((e) => e.nom);
const coupes = <T extends { nom: string; decision: string }>(entrees: readonly T[]) => entrees.filter((e) => e.decision === "couper").map((e) => e.nom);
const gardes = <T extends { nom: string; decision: string }>(entrees: readonly T[]) => entrees.filter((e) => e.decision === "garder").map((e) => e.nom);

/** Lignes d'une table du document, repérée par son commentaire « table: <nom> » : une entrée par ligne, colonnes découpées. */
function tableDuDocument(texte: string, nom: string): string[][] {
  const debut = texte.indexOf(`<!-- table: ${nom} -->`);
  assert.notEqual(debut, -1, `table « ${nom} » absente du document`);
  const lignes = texte.slice(debut).split("\n").slice(1);
  const out: string[][] = [];
  for (const ligne of lignes) {
    if (!ligne.startsWith("|")) break;
    const colonnes = ligne.slice(1, ligne.endsWith("|") ? -1 : undefined).split("|").map((c) => c.trim());
    if (colonnes.every((c) => /^-+$/.test(c))) continue;
    out.push(colonnes);
  }
  // La première ligne est l'en-tête.
  return out.slice(1);
}

const sansAccents = (cellule: string) => cellule.replaceAll("`", "");

const agentDuFaux = (nom: string, permission: Rule[] = []): FakeAgent => ({
  name: nom,
  mode: "subagent",
  options: {},
  permission,
});

// --- Agents tels qu'opencode les rend dans la salle ---------------------------------------------------------------------------------
//
// Modèle écrit d'après la lecture du paquet (`plugin-handlers/tool-config-handler.ts`, `applyToolConfig` ;
// `plugin-handlers/agent-config-assembly.ts`) et d'après les règles d'opencode déjà portées par le cockpit (`assistant-rules.ts`,
// faux opencode) : défauts d'opencode (« * * allow » en tête), règles propres des agents natifs, configuration d'instance telle que
// l'extension la laisse, section de l'agent, puis Truncate.GLOB réautorisé. L'image réelle est comparée au banc (T-L20-b, L21).

/** Fichiers de clés et .env* refusés (spéc. §3.15.1 l.474). */
const CLES_REFUSEES = { "*.env": "deny", "*.env.*": "deny", "*.key": "deny", "*.pfx": "deny", "*id_ed25519*": "deny" } as const;

/** Configuration d'instance après l'extension : webfetch et external_directory restent en tête, task est forcé à « deny ». */
const PERMISSION_SALLE = {
  webfetch: "deny",
  external_directory: "deny",
  websearch: "deny",
  read: { "*": "allow", ...CLES_REFUSEES, "*.env.example": "allow" },
  edit: { "*": "ask", ...CLES_REFUSEES, "*.env.example": "ask" },
  bash: "ask",
  task: "deny",
};

const ORCHESTRATEUR = { call_omo_agent: "deny", task: "allow", question: "allow", "task_*": "allow", teammate: "allow" };
const LECTURE_SEULE = { write: "deny", edit: "deny", apply_patch: "deny", task: "deny", call_omo_agent: "deny" };

/** Section `permission` de chaque agent de l'extension présent dans la salle, après `applyToolConfig`. */
const SECTIONS: Readonly<Record<string, Record<string, unknown>>> = {
  sisyphus: ORCHESTRATEUR,
  hephaestus: { call_omo_agent: "deny", task: "allow", question: "allow", teammate: "allow" },
  "sisyphus-junior": { "task_*": "allow", teammate: "allow" },
  prometheus: { edit: "ask", bash: "deny", webfetch: "deny", ...ORCHESTRATEUR, interactive_bash: "deny" },
  metis: LECTURE_SEULE,
  momus: LECTURE_SEULE,
  oracle: LECTURE_SEULE,
  atlas: { task: "allow", call_omo_agent: "deny", "task_*": "allow", teammate: "allow" },
};

const TRONCATURE: Rule = { permission: "external_directory", pattern: truncateGlob(), action: "allow" };

/** Agents de `GET /agent` dans la salle : natifs d'opencode (explore repris par l'extension), puis agents de l'extension. */
function agentsDeLaSalle(): FakeAgent[] {
  const natifs = nativeAgents(PERMISSION_SALLE).map((a) => ({
    ...a,
    permission: [...a.permission, ...(a.name === "explore" ? rulesFromConfig(LECTURE_SEULE) : []), TRONCATURE],
  }));
  const extension = Object.entries(SECTIONS).map(([cle, section]) => agentDuFaux(cle, effectiveAgentRules(PERMISSION_SALLE, section)));
  return [...natifs, ...extension];
}

/** Règles d'un agent de la salle, suivies de règles ajoutées (section d'agent assouplie, par exemple). */
function reglesDe(nom: string, ...ajout: Rule[]): Rule[] {
  const agent = agentsDeLaSalle().find((a) => a.name === nom);
  assert.ok(agent, nom);
  return [...agent.permission, ...ajout];
}

const allow = (permission: string, pattern = "*"): Rule => ({ permission, pattern, action: "allow" });
const nonAuditee = (agent: string, permission: string, pattern = "*"): OmoEcartAgent => ({ type: "autorisation-non-auditee", agent, permission, pattern });
const clesAutorisees = (agent: string, permission: string): OmoEcartAgent[] =>
  SONDES_FICHIERS_DE_CLES.map((sonde) => ({ type: "fichier-de-cles-autorise", agent, permission, sonde }));

async function fauxOpencode(t: TestContext, agents: FakeAgent[]): Promise<AgentLite[]> {
  const fake = new FakeOpencode();
  await fake.start();
  t.after(() => fake.close());
  fake.setAgents(agents);
  const reponse = await fetch(`${fake.url}/agent`);
  assert.equal(reponse.status, 200);
  return (await reponse.json()) as AgentLite[];
}

// --- Énumérations exactes ----------------------------------------------------------------------------------------------------------

describe("L20 : énumérations de la 4.19.4", () => {
  it("56 hooks, dont goal ; ralph-loop n'en est pas un ; noms uniques et triés", () => {
    assert.equal(HOOKS.length, 56);
    assert.equal(new Set(noms(HOOKS)).size, 56);
    assert.deepEqual(noms(HOOKS), [...noms(HOOKS)].sort());
    assert.ok(noms(HOOKS).includes("goal"));
    assert.equal(noms(HOOKS).includes("ralph-loop"), false, "ralph-loop n'est pas un nom de HookNameSchema : l'écrire serait ignoré en silence");
  });

  it("outils : chaque session_* et team_* énuméré un par un, aucun joker", () => {
    const outils = noms(OUTILS);
    assert.equal(new Set(outils).size, outils.length);
    for (const attendu of ["session_list", "session_read", "session_search", "session_info"]) assert.ok(outils.includes(attendu), attendu);
    const team = outils.filter((n) => n.startsWith("team_"));
    assert.equal(team.length, 12, "les douze outils de Team Mode sont nommés un par un");
    for (const nom of [...OUTILS_A_COUPER, ...noms(MCPS), ...noms(COMPETENCES)]) assert.equal(nom.includes("*"), false, `${nom} : aucun joker dans les listes disabled_*`);
  });

  it("skill et monitor_start sont les seuls outils qui demandent une autorisation", () => {
    const avecDemande = OUTILS.filter((o) => !o.sansDemande).map((o) => o.nom);
    assert.deepEqual(avecDemande.sort(), ["monitor_start", "skill"]);
    for (const attendu of ["skill_mcp", "look_at", "grep", "glob", "interactive_bash", "edit"]) {
      const outil = OUTILS.find((o) => o.nom === attendu);
      assert.ok(outil, attendu);
      assert.equal(outil.sansDemande, true, `${attendu} agit sans demande`);
      assert.ok(outil.preuve.fichier.startsWith("packages/"), `${attendu} : preuve par fichier du paquet`);
      assert.ok(outil.preuve.symbole.length > 0, `${attendu} : preuve par symbole`);
    }
  });

  it("agents, MCP, compétences et commandes : énumérations closes du paquet", () => {
    assert.deepEqual(AGENTS.map((a) => a.cle), [...CLES_AGENTS]);
    // Agents natifs d'opencode : dans la table de la porte G12, jamais dans les énumérations de l'extension.
    assert.deepEqual(AGENTS_OPENCODE.map((a) => a.cle), ["general", "compaction", "title", "summary"]);
    for (const natif of AGENTS_OPENCODE) assert.equal(enumerations().agents.includes(natif.cle), false, natif.cle);
    assert.deepEqual(noms(MCPS), ["codegraph", "context7", "grep_app", "lsp", "websearch"]);
    assert.equal(COMPETENCES.length, 13);
    assert.deepEqual(noms(COMMANDES), ["goal", "hyperplan", "refactor", "remove-ai-slops", "start-work", "stop-continuation"]);
    assert.equal(CLES.length, 46);
    assert.equal(new Set(CLES.map((c) => c.cle)).size, 46);
    assert.equal(FOURNISSEURS_COUPES.includes("github-copilot"), false, "le fournisseur de la salle n'est jamais coupé");
  });

  it("chaque hook, outil, MCP, compétence, commande, agent et clé porte une décision justifiée", () => {
    const familles: Array<[string, ReadonlyArray<{ decision: string; motif: string }>, ReadonlyArray<string>]> = [
      ["hooks", HOOKS, noms(HOOKS)],
      ["outils", OUTILS, noms(OUTILS)],
      ["mcps", MCPS, noms(MCPS)],
      ["compétences", COMPETENCES, noms(COMPETENCES)],
      ["commandes", COMMANDES, noms(COMMANDES)],
      ["agents", AGENTS, AGENTS.map((a) => a.cle)],
      ["agents d'opencode", AGENTS_OPENCODE, AGENTS_OPENCODE.map((a) => a.cle)],
      ["clés", CLES, CLES.map((c) => c.cle)],
    ];
    for (const [famille, entrees, etiquettes] of familles) {
      entrees.forEach((entree, index) => {
        assert.ok(entree.decision === "garder" || entree.decision === "couper", `${famille} : ${etiquettes[index]} sans décision`);
        assert.ok(entree.motif.trim().length >= 20, `${famille} : ${etiquettes[index]} sans motif`);
      });
    }
  });
});

// --- Décisions exigées par la spécification et par le plan ---------------------------------------------------------------------------

describe("L20 : décisions exigées (JS-3, JS-9, D-2b-47)", () => {
  it("hooks coupés au moins : les onze de la spécification et du plan ; quatre gardés nommément", () => {
    const aCouper = coupes(HOOKS);
    for (const nom of [
      "directory-agents-injector",
      "rules-injector",
      "goal",
      "non-interactive-env",
      "auto-update-checker",
      "ast-grep-sg-provision",
      "comment-checker",
      "codegraph-bootstrap",
      "claude-code-hooks",
      "runtime-fallback",
      "model-fallback",
    ]) {
      assert.ok(aCouper.includes(nom), `${nom} doit être coupé`);
    }
    for (const nom of ["keyword-detector", "atlas", "start-work", "todo-continuation-enforcer"]) assert.ok(gardes(HOOKS).includes(nom), `${nom} doit rester actif`);
  });

  it("disabled_tools : grep, glob, look_at, chaque session_*, chaque team_*, interactive_bash, skill_mcp", () => {
    for (const nom of ["grep", "glob", "look_at", "session_list", "session_read", "session_search", "session_info", "interactive_bash", "skill_mcp"]) {
      assert.ok(OUTILS_A_COUPER.includes(nom), `${nom} doit être dans disabled_tools`);
    }
    for (const nom of noms(OUTILS).filter((n) => n.startsWith("team_"))) assert.ok(OUTILS_A_COUPER.includes(nom), `${nom} doit être dans disabled_tools`);
    assert.equal(OUTILS_A_COUPER.includes("edit"), false, "« edit » se coupe par hashline_edit, jamais par disabled_tools");
  });

  it("disabled_agents : multimodal-looker et librarian, et eux seuls", () => {
    assert.deepEqual(AGENTS.filter((a) => a.decision === "couper").map((a) => a.cle).sort(), ["librarian", "multimodal-looker"]);
  });

  it("disabled_mcps : les cinq MCP intégrés, qui tous appellent le réseau ou lancent npm", () => {
    assert.deepEqual(coupes(MCPS).sort(), ["codegraph", "context7", "grep_app", "lsp", "websearch"]);
  });

  it("valeurs épinglées : les douze de D-2b-47, plus les pièges relevés dans le paquet", () => {
    const valeurs = valeursEpinglees();
    assert.equal(valeurs.auto_update, false);
    assert.equal(valeurs.telemetry, false);
    assert.deepEqual(valeurs.claude_code, { mcp: false, commands: false, skills: false, agents: false, hooks: false, plugins: false });
    assert.equal((valeurs.codegraph as Record<string, unknown>).enabled, false);
    assert.equal((valeurs.codegraph as Record<string, unknown>).auto_provision, false);
    assert.equal((valeurs.openclaw as Record<string, unknown>).enabled, false);
    assert.equal((valeurs.tmux as Record<string, unknown>).enabled, false);
    assert.equal((valeurs.runtime_fallback as Record<string, unknown>).enabled, false);
    assert.equal(valeurs.model_fallback, false);
    assert.equal(valeurs.hashline_edit, false);
    assert.equal((valeurs.team_mode as Record<string, unknown>).enabled, false);
    assert.equal((valeurs.background_task as Record<string, unknown>).defaultConcurrency, 2);
    // Pièges du paquet : défauts à true côté extension.
    assert.equal((valeurs.start_work as Record<string, unknown>).auto_commit, false, "le défaut du paquet est true");
    assert.equal((valeurs.goal as Record<string, unknown>).enabled, false, "coupe aussi l'ancienne boucle ralph_loop");
    assert.equal(valeurs.ralph_loop, undefined, "la clé ralph_loop reste absente : l'écrire rallumerait goal");
    assert.deepEqual(valeurs.disabled_hooks, coupes(HOOKS));
    assert.deepEqual(valeurs.disabled_tools, [...OUTILS_A_COUPER]);
    assert.deepEqual(valeurs.disabled_providers, [...FOURNISSEURS_COUPES]);
  });

  it("prometheus : trois « allow » dans le paquet, aucun audité sur edit, bash ni webfetch (JS-3, G12)", () => {
    const prometheus = AGENTS.find((a) => a.cle === "prometheus");
    assert.ok(prometheus);
    assert.equal(prometheus.decision, "garder");
    assert.deepEqual(prometheus.autorisations, [{ permission: "task", pattern: "*" }], "seul task, posé par l'extension après agents.*");
    const epingles = valeursEpinglees().agents as Record<string, { permission: Record<string, string> } | undefined>;
    assert.deepEqual(epingles.prometheus?.permission, { edit: "ask", bash: "deny", webfetch: "deny" });
    // Permissions que la configuration d'instance met à « ask » ou « deny » (spéc. l.474), plus la lecture.
    assert.deepEqual([...PERMISSIONS_SENSIBLES].sort(), ["bash", "edit", "external_directory", "read", "task", "webfetch", "websearch"]);
  });

  it("task : autorisation auditée pour les quatre agents auxquels l'extension l'accorde, et pour eux seuls", () => {
    const delegues = [...AGENTS, ...AGENTS_OPENCODE].filter((a) => a.autorisations.length > 0);
    assert.deepEqual(delegues.map((a) => a.cle).sort(), ["atlas", "hephaestus", "prometheus", "sisyphus"]);
    for (const agent of delegues) assert.deepEqual(agent.autorisations, [{ permission: "task", pattern: "*" }], agent.cle);
    assert.ok(PERMISSIONS_POSEES.some((f) => f.preuve.symbole === "applyToolConfig" && f.quoi.includes("task forcé")), "task forcé à deny au niveau global");
    assert.ok(PERMISSIONS_POSEES.some((f) => f.quoi.includes("webfetch et external_directory")), "piège pour la configuration d'instance");
  });

  it("autorisations communes d'opencode : lecture et sorties tronquées, rien d'autre ; cinq fichiers de clés sondés", () => {
    assert.deepEqual(
      AUTORISATIONS_OPENCODE.map((a) => [a.permission, a.pattern]),
      [
        ["read", "*"],
        ["external_directory", truncateGlob()],
      ],
    );
    assert.deepEqual([...PERMISSIONS_SONDEES], ["read", "edit"]);
    assert.equal(SONDES_FICHIERS_DE_CLES.length, 5);
    for (const sonde of SONDES_FICHIERS_DE_CLES) assert.ok(sonde.startsWith("/workspace/"), sonde);
  });

  it("OpenCode-Builder n'est pas attendu dans GET /agent : l'extension ne le crée que sur un réglage laissé à false", () => {
    assert.deepEqual(
      [...AGENTS, ...AGENTS_OPENCODE].filter((a) => !a.attendu).map((a) => a.cle),
      ["OpenCode-Builder", "librarian", "multimodal-looker"],
    );
  });

  it("appels réseau et écritures disque connus : F-t, F-u et tui.json nommés, chacun avec sa preuve", () => {
    for (const fait of [...RESEAU, ...DISQUE]) {
      assert.ok(fait.preuve.fichier.startsWith("packages/"), fait.preuve.fichier);
      assert.ok(fait.preuve.symbole.length > 0, fait.preuve.fichier);
    }
    assert.ok(DISQUE.some((d) => d.preuve.symbole === "migrateLegacyWorkspaceDirectory"), "F-t : renommage .sisyphus → .omo");
    assert.ok(DISQUE.some((d) => d.chemin.includes("oh-my-opencode.json[c]")), "F-u : configurations héritées");
    assert.ok(DISQUE.some((d) => d.chemin.includes("tui.json")), "écriture de tui.json");
    assert.ok(RESEAU.some((r) => r.hote.includes("posthog")), "télémétrie");
    assert.ok(RESEAU.some((r) => r.hote.includes("models.dev")), "catalogue des capacités des IA");
  });
});

// --- T-L20-a : porte G12 sur le faux opencode ---------------------------------------------------------------------------------------

describe("L20 : porte G12 sur GET /agent (T-L20-a)", () => {
  it("agents de la salle tels qu'opencode les rend (« * * allow » en tête, natifs compris) : aucun écart", async (t) => {
    const agents = await fauxOpencode(t, agentsDeLaSalle());
    assert.ok(agents.every((a) => a.permission?.[0]?.permission === "*" && a.permission[0].action === "allow"), "chaque agent commence par « * * allow »");
    assert.deepEqual(compareAgentsToAudit(agents), []);
    assert.deepEqual(compareAgentsToAudit(agents, { exigerPresence: true }), []);
  });

  it("un « allow » en vigueur hors table sur une permission sensible : échec", async (t) => {
    for (const permission of PERMISSIONS_SENSIBLES) {
      const agents = agentsDeLaSalle().map((a) => (a.name === "explore" ? { ...a, permission: [...a.permission, allow(permission)] } : a));
      const lus = await fauxOpencode(t, agents);
      // read * est une autorisation commune d'opencode : seules les sondes des fichiers de clés le voient.
      const attendus = [
        ...(permission === "read" ? [] : [nonAuditee("explore", permission)]),
        ...(PERMISSIONS_SONDEES.includes(permission) ? clesAutorisees("explore", permission) : []),
      ];
      assert.deepEqual(compareAgentsToAudit(lus), attendus, permission);
    }
  });

  it("la dernière règle qui correspond l'emporte : un « allow » repris ensuite n'est pas un écart, l'ordre inverse l'est", () => {
    const agent = (permission: Rule[]): AgentLite => ({ name: "explore", mode: "subagent", permission });
    assert.deepEqual(compareAgentsToAudit([agent([allow("bash"), { permission: "bash", pattern: "*", action: "ask" }])]), []);
    assert.deepEqual(compareAgentsToAudit([agent([{ permission: "bash", pattern: "*", action: "ask" }, allow("bash")])]), [nonAuditee("explore", "bash")]);
    // Reprise sur un motif plus étroit : l'« allow » vaut toujours pour les autres commandes.
    assert.deepEqual(compareAgentsToAudit([agent([allow("bash"), { permission: "bash", pattern: "git *", action: "ask" }])]), [nonAuditee("explore", "bash")]);
    // Un « allow » repris sur son motif exact, puis rouvert plus loin : un seul écart par permission et par motif.
    assert.deepEqual(compareAgentsToAudit([agent([allow("bash"), allow("bash")])]), [nonAuditee("explore", "bash")]);
  });

  it("une règle « * allow » vise chaque permission sensible", () => {
    const ecarts = compareAgentsToAudit([{ name: "explore", mode: "subagent", permission: [allow("*")] }]);
    assert.deepEqual(ecarts, [
      ...PERMISSIONS_SENSIBLES.filter((p) => p !== "read").map((p) => nonAuditee("explore", p)),
      ...PERMISSIONS_SONDEES.flatMap((p) => clesAutorisees("explore", p)),
    ]);
  });

  it("autorisations communes d'opencode : lecture et sorties tronquées acceptées pour tout agent, pas un autre dossier", () => {
    const agent = (permission: Rule[]): AgentLite => ({ name: "general", mode: "subagent", permission });
    assert.deepEqual(compareAgentsToAudit([agent([allow("read", "src/**"), allow("external_directory", truncateGlob())])]), []);
    assert.deepEqual(compareAgentsToAudit([agent([allow("external_directory", "/home/node/**")])]), [nonAuditee("general", "external_directory", "/home/node/**")]);
    assert.deepEqual(compareAgentsToAudit([agent([allow("read", "src/**")])], { communes: [] }), [nonAuditee("general", "read", "src/**")]);
  });

  it("task : accepté pour les quatre agents auxquels l'extension l'accorde, refusé ailleurs", () => {
    for (const nom of ["atlas", "sisyphus", "hephaestus", "prometheus"]) assert.deepEqual(compareAgentsToAudit([{ name: nom, mode: "all", permission: [allow("task")] }]), [], nom);
    for (const nom of ["explore", "sisyphus-junior", "build", "general"]) {
      assert.deepEqual(compareAgentsToAudit([{ name: nom, mode: "all", permission: [allow("task")] }]), [nonAuditee(nom, "task")], nom);
    }
  });

  it("une section d'agent qui rouvre les fichiers de clés : échec, même si read * est audité", async (t) => {
    const agents = agentsDeLaSalle().map((a) => (a.name === "sisyphus" ? { ...a, permission: reglesDe("sisyphus", allow("read")) } : a));
    const lus = await fauxOpencode(t, agents);
    assert.deepEqual(compareAgentsToAudit(lus), clesAutorisees("sisyphus", "read"));
    const env = compareAgentsToAudit([{ name: "sisyphus", mode: "all", permission: reglesDe("sisyphus", allow("edit", "*.env")) }]);
    assert.deepEqual(env, [nonAuditee("sisyphus", "edit", "*.env"), { type: "fichier-de-cles-autorise", agent: "sisyphus", permission: "edit", sonde: "/workspace/projet/.env" }]);
  });

  it("une autorisation inscrite dans la table est acceptée, pas les autres", () => {
    const table: OmoAgentAudit[] = AGENTS.map((a) => (a.cle === "sisyphus" ? { ...a, autorisations: [{ permission: "edit", pattern: "src/**" }] } : a));
    const edition: AgentLite = { name: "sisyphus", mode: "all", permission: [allow("edit", "src/**")] };
    assert.deepEqual(compareAgentsToAudit([edition], { table }), []);
    assert.deepEqual(compareAgentsToAudit([edition]), [nonAuditee("sisyphus", "edit", "src/**")]);
    const ailleurs: AgentLite = { name: "sisyphus", mode: "all", permission: [allow("edit", "/etc/**")] };
    assert.deepEqual(compareAgentsToAudit([ailleurs], { table }), [nonAuditee("sisyphus", "edit", "/etc/**")]);
  });

  it("agents natifs d'opencode : connus de la porte, rôle « autres » ; sans eux dans la table, inconnus", () => {
    const natifs: AgentLite[] = AGENTS_OPENCODE.map((a) => ({ name: a.cle, mode: "primary", permission: [] }));
    assert.deepEqual(compareAgentsToAudit(natifs), []);
    assert.deepEqual(
      compareAgentsToAudit(natifs, { table: AGENTS }),
      AGENTS_OPENCODE.map((a) => ({ type: "agent-inconnu", agent: a.cle })),
    );
    for (const natif of AGENTS_OPENCODE) assert.equal(natif.role, "autres", natif.cle);
  });

  it("présence exigée : un agent attendu manque → écart ; OpenCode-Builder absent → aucun", async (t) => {
    const lus = await fauxOpencode(t, agentsDeLaSalle());
    assert.equal(lus.some((a) => a.name === "OpenCode-Builder"), false);
    assert.deepEqual(compareAgentsToAudit(lus, { exigerPresence: true }), []);
    assert.deepEqual(compareAgentsToAudit(lus.filter((a) => a.name !== "general"), { exigerPresence: true }), [{ type: "agent-absent", agent: "general" }]);
  });

  it("agent inconnu de la table, agent coupé toujours présent, agent gardé absent", async (t) => {
    const agents = [...agentsDeLaSalle(), agentDuFaux("athena"), agentDuFaux("librarian")];
    const lus = await fauxOpencode(t, agents);
    assert.deepEqual(compareAgentsToAudit(lus), [
      { type: "agent-inconnu", agent: "athena" },
      { type: "agent-coupe-present", agent: "librarian" },
    ]);
    const sansSisyphus = compareAgentsToAudit(lus.filter((a) => a.name !== "sisyphus"), { exigerPresence: true });
    assert.ok(sansSisyphus.some((e) => e.type === "agent-absent" && e.agent === "sisyphus"));
    assert.deepEqual(compareAgentsToAudit(lus.filter((a) => a.name !== "sisyphus")).some((e) => e.type === "agent-absent"), false, "absence signalée seulement si on l'exige");
  });

  it("la casse du nom ne fait pas passer un agent pour inconnu", () => {
    assert.deepEqual(compareAgentsToAudit([{ name: "PROMETHEUS", mode: "all", permission: [] }]), []);
    assert.deepEqual(compareAgentsToAudit([{ name: "LIBRARIAN", mode: "all", permission: [] }]), [{ type: "agent-coupe-present", agent: "LIBRARIAN" }]);
  });

  it("une règle « ask » ou « deny » n'est jamais un écart", () => {
    const regles: Rule[] = PERMISSIONS_SENSIBLES.flatMap((permission) => [
      { permission, pattern: "*", action: "ask" as const },
      { permission, pattern: "*", action: "deny" as const },
    ]);
    assert.deepEqual(compareAgentsToAudit([{ name: "build", mode: "all", permission: regles }]), []);
  });
});

// --- T-L20-c : rôles ------------------------------------------------------------------------------------------------------------------

describe("L20 : rôles par clé de configuration (T-L20-c)", () => {
  it("athena et council-member tombent dans « autres »", () => {
    assert.equal(roleDeAgent("athena"), "autres");
    assert.equal(roleDeAgent("council-member"), "autres");
    assert.equal(roleDeAgent(""), "autres");
    assert.equal(roleDeAgent(null), "autres");
    assert.equal(roleDeAgent(undefined), "autres");
  });

  it("chaque clé de la 4.19.4 a un rôle connu, quelle que soit la casse", () => {
    for (const cle of CLES_AGENTS) {
      const role = roleDeAgent(cle);
      assert.notEqual(role, "autres", cle);
      assert.ok(OMO_ROLES.includes(role), cle);
      assert.equal(roleDeAgent(cle.toUpperCase()), role, `${cle} : casse ignorée`);
    }
    assert.equal(roleDeAgent("sisyphus"), "planifier");
    assert.equal(roleDeAgent("sisyphus-junior"), "executer");
    assert.equal(roleDeAgent("oracle"), "conseiller");
    assert.equal(roleDeAgent("momus"), "verifier");
    assert.equal(roleDeAgent("explore"), "chercher");
  });

  it("la table des rôles ne sert que des clés de configuration, jamais un nom affiché", () => {
    // « Orchestrateur (Sisyphus) » et « Sisyphus - OhMyOpenCode » sont des displayName : ils ne portent aucun rôle.
    assert.equal(roleDeAgent("Sisyphus - OhMyOpenCode"), "autres");
    assert.equal(roleDeAgent("Orchestrateur (Sisyphus)"), "autres");
    assert.deepEqual(AGENTS.map((a) => a.role), CLES_AGENTS.map((cle) => roleDeAgent(cle)));
  });
});

// --- T-L20-e : tableau « sans demande » engendré ---------------------------------------------------------------------------------------

describe("L20 : tableau « sans demande » engendré depuis la table (T-L20-e)", () => {
  it("une ligne par entrée gardée et sans demande, et rien d'autre", () => {
    const attendues = [
      ...OUTILS.filter((o) => o.decision === "garder" && o.sansDemande).map((o) => o.nom),
      ...HOOKS.filter((h) => h.decision === "garder" && h.sansDemande).map((h) => h.nom),
    ];
    assert.deepEqual(tableauSansDemande().map((l) => l.nom), attendues);
    assert.ok(attendues.includes("task"));
    assert.ok(attendues.includes("todo-continuation-enforcer"));
    assert.equal(attendues.includes("skill"), false, "skill demande une autorisation");
    assert.equal(attendues.includes("grep"), false, "grep est coupé");
  });

  it("chaque ligne porte un libellé français, jamais le nom brut", () => {
    for (const ligne of tableauSansDemande()) {
      assert.notEqual(ligne.libelle, ligne.nom, `${ligne.nom} : libellé manquant dans TEXTES`);
      assert.ok(ligne.libelle.endsWith("."), `${ligne.nom} : phrase attendue`);
      assert.ok(ligne.categorie === "outil" || ligne.categorie === "hook");
    }
  });

  it("le tableau suit la table : une entrée ajoutée apparaît, une entrée coupée disparaît", () => {
    const outils: OmoOutilAudit[] = OUTILS.map((o) => (o.nom === "task" ? { ...o, decision: "couper" } : o));
    assert.equal(tableauSansDemande(outils).some((l) => l.nom === "task"), false);
    const hooks: OmoHookAudit[] = HOOKS.map((h) => (h.nom === "think-mode" ? { ...h, sansDemande: true } : h));
    assert.ok(tableauSansDemande(OUTILS, hooks).some((l) => l.nom === "think-mode"));
    // Nom sans libellé : rendu sous son nom brut, ce que le test précédent refuse.
    assert.equal(tableauSansDemande(OUTILS, hooks).find((l) => l.nom === "think-mode")?.libelle, "think-mode");
  });

  it("gabarit de version rempli par l'appelant", () => {
    assert.equal(formatVersionAuditee(OMO_VERSION, "2026-09-18"), "Version 4.19.4, auditée le 2026-09-18");
  });
});

// --- enums-4.19.4.json et document -----------------------------------------------------------------------------------------------------

describe("L20 : fichier d'énumérations et document", () => {
  it("docker/opencode-omo/enums-4.19.4.json est égal à la table machine", () => {
    assert.deepEqual(JSON.parse(lire(ENUMS)), JSON.parse(JSON.stringify(enumerations())));
  });

  it("le document porte les mêmes noms et les mêmes décisions que la table", () => {
    const texte = lire(DOC);
    const paires = (table: string) => tableDuDocument(texte, table).map((cols) => [sansAccents(cols[0] ?? ""), cols[1] ?? ""]);
    assert.deepEqual(paires("hooks"), HOOKS.map((h) => [h.nom, h.decision]));
    assert.deepEqual(paires("outils"), OUTILS.map((o) => [o.nom, o.decision]));
    assert.deepEqual(paires("mcps"), MCPS.map((m) => [m.nom, m.decision]));
    assert.deepEqual(paires("competences"), COMPETENCES.map((c) => [c.nom, c.decision]));
    assert.deepEqual(paires("commandes"), COMMANDES.map((c) => [c.nom, c.decision]));
    assert.deepEqual(paires("agents"), AGENTS.map((a) => [a.cle, a.decision]));
    assert.deepEqual(paires("agents-opencode"), AGENTS_OPENCODE.map((a) => [a.cle, a.decision]));
    assert.deepEqual(paires("cles"), CLES.map((c) => [c.cle, c.decision]));
    // Présence attendue et autorisations auditées : mêmes valeurs que la table.
    const oui = (a: OmoAgentAudit) => (a.attendu ? "oui" : "non");
    const autos = (a: OmoAgentAudit) => (a.autorisations.length === 0 ? "aucune" : a.autorisations.map((x) => `${x.permission} ${x.pattern}`).join(", "));
    const colonnes = (table: string) => tableDuDocument(texte, table).map((cols) => [cols[3] ?? "", sansAccents(cols[4] ?? "")]);
    assert.deepEqual(colonnes("agents"), AGENTS.map((a) => [oui(a), autos(a)]));
    assert.deepEqual(colonnes("agents-opencode"), AGENTS_OPENCODE.map((a) => [oui(a), autos(a)]));
    assert.deepEqual(
      tableDuDocument(texte, "autorisations-communes").map((cols) => [sansAccents(cols[0] ?? ""), sansAccents(cols[1] ?? "")]),
      AUTORISATIONS_OPENCODE.map((a) => [a.permission, a.pattern]),
    );
  });

  it("le document reprend le tableau « sans demande », les appels réseau et les écritures disque", () => {
    const texte = lire(DOC);
    assert.deepEqual(
      tableDuDocument(texte, "sans-demande").map((cols) => sansAccents(cols[0] ?? "")),
      tableauSansDemande().map((l) => l.nom),
    );
    assert.equal(tableDuDocument(texte, "reseau").length, RESEAU.length);
    assert.equal(tableDuDocument(texte, "disque").length, DISQUE.length);
    assert.deepEqual(
      tableDuDocument(texte, "permissions-posees").map((cols) => cols[0] ?? ""),
      PERMISSIONS_POSEES.map((f) => f.quoi),
    );
    for (const sonde of SONDES_FICHIERS_DE_CLES) assert.ok(texte.includes(`\`${sonde}\``), `sonde ${sonde} nommée`);
    assert.ok(texte.includes(TEXTES.avance.titre), "le titre du tableau §4.10 vient des textes");
  });

  it("le document cite des noms, des chemins et des symboles : aucun bloc de code, aucune ligne de plus de 200 caractères (D-2b-31)", () => {
    const texte = lire(DOC);
    assert.equal(texte.includes("```"), false, "aucun bloc de code");
    assert.equal(texte.includes("~~~"), false, "aucun bloc de code");
    const longues = texte.split("\n").map((ligne, index) => ({ index: index + 1, taille: ligne.length })).filter((l) => l.taille > 200);
    assert.deepEqual(longues, [], "aucune ligne de plus de 200 caractères");
    for (const ligne of texte.split("\n")) assert.equal(/^ {4,}\S/.test(ligne), false, `bloc indenté : ${ligne.slice(0, 40)}`);
    // Marqueurs et consignes de l'extension : jamais recopiés, même partiellement.
    for (const interdit of ["SYSTEM DIRECTIVE", "OMO_INTERNAL", "MUST USE", "You are"]) assert.equal(texte.includes(interdit), false, interdit);
  });

  it("le document nomme les quatre faits de forme et les pièges relevés", () => {
    const texte = lire(DOC);
    for (const attendu of [
      "filterDisabledTools",
      "mergeConfigs",
      "migrateRalphLoopConfig",
      "PROMETHEUS_PERMISSION",
      "hashline_edit",
      "start_work.auto_commit",
      "applyToolConfig",
      "TASK_DENIED_SUBAGENT_KEYS",
      "default_builder_enabled",
    ]) {
      assert.ok(texte.includes(attendu), attendu);
    }
    assert.ok(texte.includes("SUL-1.0"), "la licence du paquet est rappelée");
  });
});

// --- T-L20-d : pureté ---------------------------------------------------------------------------------------------------------------

describe("L20 : pureté des modules partagés (T-L20-d)", () => {
  it("omo-audit-4.19.4.ts, omo-audit-texts.ts et omo-roles.ts : ni module node, ni horloge, ni aléa, ni réseau", () => {
    for (const fichier of ["omo-audit-4.19.4.ts", "omo-audit-texts.ts", "omo-roles.ts"]) {
      const source = lire(path.join(SERVER_DIR, "shared", fichier));
      assert.equal(source.includes('"node:'), false, fichier);
      assert.equal(/\bprocess\./.test(source), false, fichier);
      assert.equal(/\brequire\s*\(/.test(source), false, fichier);
      assert.equal(/\bDate\.now\b|new Date\b|Math\.random|\bsetTimeout\b|\bperformance\./.test(source), false, fichier);
      const imports = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "");
      for (const spec of imports) assert.ok(/^\.\/[\w.-]+\.ts$/.test(spec), `${fichier} : import refusé ${spec}`);
    }
  });

  it("la table ne lit aucun fichier : les énumérations sont des données, le JSON est comparé par le test", () => {
    const source = lire(path.join(SERVER_DIR, "shared", "omo-audit-4.19.4.ts"));
    assert.equal(source.includes("readFileSync"), false);
    assert.equal(source.includes("enums-4.19.4.json"), true, "le fichier jumeau est nommé en commentaire, jamais lu");
  });
});
