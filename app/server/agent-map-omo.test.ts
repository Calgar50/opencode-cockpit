// Onglet « Salle OMO » de la carte des assistants (1.1, grande fusion F2 · V2, paquet L39o ; spécification §5.2 l.892, §7.8
// l.1185, P11 l.46, P2 ; plan d'exécution it4, fiche L39o et §7.2 ; plan it5 §8.7 ; fiche-fusion-v106 §7, test T-L39).
// Ce que ce fichier tient :
// - route GET /api/agent-map?instance=omo : mode Simple → 403 mode-avance, rien demandé à la salle ; salle coupée
//   (`c11.instances.omo` nul, SALLE_OUVERTE faux) → 409 salle-coupee avec la phrase de la salle ; faux de la salle (harnais,
//   option omo) → agents lus par SA recherche d'agents, rôles par clé (« Planifier (sisyphus) », « Autres (athena) »), internes
//   exclus, jamais les agents de l'instance principale ; instance inconnue → 400 ; salle illisible → 502 sans repli ;
// - T-L39 : dossier %XX → 403 forbidden-directory, zéro requête au faux de la salle, contrôle de l'instance de la salle ; salle
//   coupée → 409 inchangé ;
// - AUCUNE écriture : base et dossiers de la salle inchangés, que des GET vers les deux instances, aucun redémarrage ;
// - module pur shared/agent-map-omo.ts : libellés lus dans les textes de la salle, aucune table propre ;
// - interface : aucune chaîne de rôle dans CarteSalleOmo.tsx (contrôle de source), onglet monté en mode Avancé seulement,
//   sections l39o:salle-omo appariées et jamais imbriquées avec c5:vue-ensemble ni avec un bloc de l'itération 4, un seul appel
//   de la route dans le client, textes de l'onglet en Avancé seulement.
// Chaque garde a un contrôle discriminant ou une mutation qui la fait tomber (rapport du paquet).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import type { AgentMapResult } from "./shared/agent-map.ts";
import { type AgentMapSalleResult, libelleAgentDeLaSalle, SALLE_AGENTS_MAX, vueDeLaSalle } from "./shared/agent-map-omo.ts";
import { TEXTES } from "./shared/agent-map-texts.ts";
import { TEXTES as NEON } from "./shared/neon-texts.ts";
import { OMO_ROLES, roleDeAgent } from "./shared/omo-roles.ts";
import { TEXTES as SALLE } from "./shared/omo-room-texts.ts";
import { INTERNAL_AGENTS } from "./studio.ts";
import { type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakeAgent, FakeOpencode } from "./test-support/fake-opencode.ts";
import { SALLE_OUVERTE } from "./wiring-11.ts";

const APP = path.join(import.meta.dirname, "..");
const CARTE = path.join(APP, "web", "pages", "assistants", "carte");
const lire = (relatif: string) => fs.readFileSync(path.join(APP, relatif), "utf8");
const C = TEXTES.partout;
const q = (value: string) => encodeURIComponent(value);

/** Dossier piège (fiche-fusion-v106 §7, A22) : après le second décodage d'opencode 1.18.30, il sortirait du workspace. */
const TRAP = "a%2F..%2F..%2Fhome%2Fnode%2F.local%2Fshare%2Fopencode";

/** Harnais avec le seul module de la carte, comme agent-map-service.test.ts. */
const carte = (t: TestContext, options: CockpitHarnessOptions = {}) => startCockpit(t, { ...options, equipes: ["agentMap"] });

/** Carte de la salle, mode Avancé, salle branchée sur son faux (harnais, option omo : instance RÉELLE de instance-runtime.ts). */
async function salleAvancee(t: TestContext): Promise<{ h: CockpitHarness; omo: NonNullable<CockpitHarness["omo"]> }> {
  const h = await carte(t, { omo: true, settings: { ui: { mode: "avance" } } });
  assert.ok(h.omo, "harnais : option omo");
  return { h, omo: h.omo };
}

async function appel(h: CockpitHarness, query: string): Promise<{ status: number; body: unknown }> {
  const res = await h.call("GET", `/api/agent-map${query}`, { headers: h.headers.authed });
  return { status: res.status, body: res.json() };
}

/** Trafic propre du processeur de chaque instance (flux, rattrapage) : il n'est pas une lecture de la carte. */
const CHEMINS_PROCESSEUR = new Set(["/global/event", "/experimental/session"]);

/** Requêtes reçues par un faux depuis un repère, hors trafic du processeur, avec leur dossier s'il y en a un. */
const requetes = (fake: FakeOpencode, depuis: number): string[] =>
  fake.requests
    .slice(depuis)
    .filter((r) => !CHEMINS_PROCESSEUR.has(r.pathname))
    .map((r) => `${r.method} ${r.pathname}${r.query.directory === undefined ? "" : `?directory=${r.query.directory}`}`);

/** Contenu complet de la base, pour prouver qu'une lecture n'écrit rien (noms de tables lus dans le schéma, jamais reçus). */
function contenuBase(db: DatabaseSync): string {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as unknown as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => /^[A-Za-z0-9_]+$/.test(name));
  return JSON.stringify(tables.map((name) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
}

/** Agents de la salle servis par son faux : clés d'Oh My OpenAgent 4.19.4, une clé maison, des internes et un doublon. */
function agentsDeLaSalle(regles: FakeAgent["permission"] = []): FakeAgent[] {
  const agent = (name: string, mode: FakeAgent["mode"] = "subagent"): FakeAgent => ({ name, mode, options: {}, permission: regles });
  return [
    agent("athena"),
    agent("sisyphus", "primary"),
    agent("explore"),
    agent("oracle"),
    agent("OpenCode-Builder", "all"),
    agent("momus"),
    agent("constructor"),
    agent("compaction", "primary"),
    agent("title", "primary"),
    agent("cockpit-controle", "primary"),
    agent("sisyphus", "primary"),
  ];
}

/** Réponse attendue pour agentsDeLaSalle, écrite EN CLAIR : ordre des rôles, puis des clés ; internes et doublon retirés. */
const ATTENDU: AgentMapSalleResult = {
  agents: [
    { cle: "sisyphus", role: "planifier", libelle: "Planifier (sisyphus)" },
    { cle: "explore", role: "chercher", libelle: "Chercher (explore)" },
    { cle: "oracle", role: "conseiller", libelle: "Conseiller (oracle)" },
    { cle: "OpenCode-Builder", role: "executer", libelle: "Exécuter (OpenCode-Builder)" },
    { cle: "momus", role: "verifier", libelle: "Vérifier (momus)" },
    { cle: "athena", role: "autres", libelle: "Autres (athena)" },
    { cle: "constructor", role: "autres", libelle: "Autres (constructor)" },
  ],
};

describe("onglet « Salle OMO » : route GET /api/agent-map?instance=omo (L39o)", () => {
  it("mode Simple : 403 mode-avance avec la phrase de la carte, et RIEN n'est demandé à la salle ni à l'instance principale (P2, P11)", async (t) => {
    const h = await carte(t, { omo: true });
    assert.ok(h.omo);
    const repereSalle = h.omo.fake.requests.length;
    const reperePrincipal = h.fake.requests.length;
    for (const query of ["?instance=omo", `?instance=omo&directory=${q(h.fake.directory)}`, `?instance=omo&directory=${q(`${h.fake.directory}/${TRAP}`)}`]) {
      const res = await appel(h, query);
      assert.equal(res.status, 403, query);
      assert.deepEqual(res.body, { error: "mode-avance", message: C.erreurs["mode-avance"] }, query);
    }
    assert.deepEqual(requetes(h.omo.fake, repereSalle), [], "rien ne part vers la salle en mode Simple");
    assert.deepEqual(requetes(h.fake, reperePrincipal), [], "aucun repli sur l'instance principale");
  });

  it("salle coupée (instances.omo nul, SALLE_OUVERTE faux) : 409 salle-coupee avec « Salle coupée » de la salle, dossier %XX compris", async (t) => {
    assert.equal(SALLE_OUVERTE, false, "la salle reste fermée dans le dépôt");
    const h = await carte(t, { settings: { ui: { mode: "avance" } } });
    assert.equal(h.omo, null);
    assert.equal(h.cockpit.c11.instances?.omo ?? null, null, "salle coupée : aucune instance");
    const repere = h.fake.requests.length;
    for (const query of ["?instance=omo", `?instance=omo&directory=${q(h.fake.directory)}`, `?instance=omo&directory=${q(`${h.fake.directory}/${TRAP}`)}`]) {
      const res = await appel(h, query);
      assert.equal(res.status, 409, query);
      assert.deepEqual(res.body, { error: "salle-coupee", message: SALLE.avance.etats.coupee }, query);
    }
    // Phrase de la salle, jamais celle de la carte : agent-map-texts.ts n'a aucune clé salle-coupee (T4t, croisement de V0).
    assert.equal(SALLE.avance.etats.coupee, "Salle coupée");
    assert.equal(Object.hasOwn(C.erreurs, "salle-coupee"), false);
    assert.deepEqual(requetes(h.fake, repere), [], "salle coupée : aucun repli sur l'instance principale");
    // La carte de l'instance principale, elle, reste servie (400/403/502 inchangés, 200 ici).
    assert.equal((await appel(h, `?directory=${q(h.fake.directory)}`)).status, 200);
  });

  it("faux de la salle : agents lus par SA recherche d'agents, rôles par clé, libellés des textes de la salle, internes exclus", async (t) => {
    const { h, omo } = await salleAvancee(t);
    omo.fake.setAgents(agentsDeLaSalle(omo.fake.agents()[0]?.permission));
    const repereSalle = omo.fake.requests.length;
    const reperePrincipal = h.fake.requests.length;
    const res = await appel(h, "?instance=omo");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, ATTENDU);
    // Sans dossier : lecture GLOBALE de la salle (aucun dossier transmis), par son client ; l'instance principale n'est pas lue.
    assert.deepEqual(requetes(omo.fake, repereSalle).sort(), ["GET /agent", "GET /command"]);
    assert.deepEqual(requetes(h.fake, reperePrincipal), [], "P11 : la carte de la salle ne lit jamais l'instance principale");
    // Libellé = secteur des textes de la salle (neon-texts.ts), par la clé ; aucun rôle « orchestrateur ».
    for (const agent of (res.body as AgentMapSalleResult).agents) {
      assert.equal(agent.role, roleDeAgent(agent.cle), agent.cle);
      assert.equal(agent.libelle, `${NEON.partout.secteurs[agent.role]} (${agent.cle})`, agent.cle);
      assert.equal(/orchestrat/i.test(agent.libelle), false, agent.libelle);
    }
    assert.equal(roleDeAgent("sisyphus"), "planifier");
    // Les agents de l'instance principale (build, plan, general…) n'entrent pas dans la vue de la salle.
    const principaux = h.fake.agents().map((agent) => agent.name);
    assert.ok(principaux.includes("general"), "le faux principal a bien des agents à lui");
    assert.equal((res.body as AgentMapSalleResult).agents.some((agent) => agent.cle === "general"), false);
  });

  it("dossier du workspace : lu par dossier dans la salle, après le contrôle de SON instance (délégation à projects.isAllowedDirectory)", async (t) => {
    const { h, omo } = await salleAvancee(t);
    omo.fake.setAgents(agentsDeLaSalle(omo.fake.agents()[0]?.permission));
    const vus: string[] = [];
    const controle = omo.deps.isAllowedDirectory;
    omo.deps.isAllowedDirectory = (dir) => {
      vus.push(dir);
      return controle(dir);
    };
    t.after(() => {
      omo.deps.isAllowedDirectory = controle;
    });
    const projet = `${h.fake.directory}/proj`;
    const remise = `${h.fake.directory}/Remise 20%`;
    for (const dossier of [projet, remise]) {
      const repere = omo.fake.requests.length;
      const res = await appel(h, `?instance=omo&directory=${q(dossier)}`);
      assert.equal(res.status, 200, `${dossier} : ${JSON.stringify(res.body)}`);
      assert.deepEqual(res.body, ATTENDU, dossier);
      // Nom légitime (« % » isolé) relayé à l'octet ; le dossier est celui de la conversation, jamais un autre.
      assert.deepEqual(requetes(omo.fake, repere).sort(), [`GET /agent?directory=${dossier}`, `GET /command?directory=${dossier}`], dossier);
    }
    assert.deepEqual(vus, [projet, remise], "chaque dossier est passé au contrôle de l'instance de la salle");
    // Le contrôle de la salle DÉCIDE : un refus de sa part ferme la lecture, même pour un dossier que la principale accepterait.
    omo.deps.isAllowedDirectory = () => false;
    const repere = omo.fake.requests.length;
    const refus = await appel(h, `?instance=omo&directory=${q(projet)}`);
    assert.equal(refus.status, 403);
    assert.deepEqual(refus.body, { error: "forbidden-directory", message: C.erreurs["forbidden-directory"] });
    assert.deepEqual(requetes(omo.fake, repere), []);
    assert.deepEqual(omo.fake.instancesHors(), [], "aucune instance de la salle hors du workspace");
  });

  it("T-L39 : dossier %XX → 403 forbidden-directory, zéro requête au faux de la salle, aucune instance hors du workspace", async (t) => {
    const { h, omo } = await salleAvancee(t);
    const repereSalle = omo.fake.requests.length;
    const reperePrincipal = h.fake.requests.length;
    for (const nom of [TRAP, "a%2e%2e", "Remise%2F..", "x%00"]) {
      const res = await appel(h, `?instance=omo&directory=${q(`${h.fake.directory}/${nom}`)}`);
      assert.equal(res.status, 403, nom);
      assert.deepEqual(res.body, { error: "forbidden-directory", message: C.erreurs["forbidden-directory"] }, nom);
    }
    // Hors du workspace, sans séquence %XX : même refus, même silence.
    for (const dossier of ["/etc", `${h.fake.directory}/../etc`]) {
      const res = await appel(h, `?instance=omo&directory=${q(dossier)}`);
      assert.equal(res.status, 403, dossier);
    }
    assert.deepEqual(requetes(omo.fake, repereSalle), [], "zéro requête au faux de la salle");
    assert.deepEqual(requetes(h.fake, reperePrincipal), [], "zéro requête au faux principal");
    const percent = /%[0-9A-Fa-f]{2}/;
    for (const fake of [omo.fake, h.fake]) {
      assert.deepEqual(
        fake.requests.filter((r) => percent.test(r.query.directory ?? "")).map((r) => `${r.method} ${r.pathname}`),
        [],
        "aucun dossier %XX transmis",
      );
      assert.deepEqual(fake.instancesHors(), []);
    }
  });

  it("instance inconnue : 400 invalid, rien de lu ; « principale » ou absente : la carte de l'instance principale, inchangée", async (t) => {
    const { h, omo } = await salleAvancee(t);
    const repereSalle = omo.fake.requests.length;
    for (const valeur of ["OMO", "salle", "omo ", "autre", "principale,omo"]) {
      const repere = h.fake.requests.length;
      const res = await appel(h, `?instance=${q(valeur)}&directory=${q(h.fake.directory)}`);
      assert.equal(res.status, 400, valeur);
      assert.deepEqual(res.body, { error: "invalid", message: C.erreurs.invalid }, valeur);
      assert.deepEqual(requetes(h.fake, repere), [], `${valeur} : jamais lue comme la principale`);
    }
    assert.deepEqual(requetes(omo.fake, repereSalle), []);
    const sans = await appel(h, `?directory=${q(h.fake.directory)}`);
    const principale = await appel(h, `?instance=principale&directory=${q(h.fake.directory)}`);
    const vide = await appel(h, `?instance=&directory=${q(h.fake.directory)}`);
    assert.equal(sans.status, 200);
    assert.deepEqual(principale, sans);
    assert.deepEqual(vide, sans);
    assert.ok(Array.isArray((sans.body as AgentMapResult).nodes), "réponse de la carte principale (AgentMapResult)");
    assert.deepEqual(requetes(omo.fake, repereSalle), [], "la carte principale ne lit jamais la salle (P11)");
  });

  it("salle illisible : 502 avec la phrase générale de la carte, sans repli sur l'instance principale", async (t) => {
    const { h, omo } = await salleAvancee(t);
    const lecture = omo.deps.lookup.get.bind(omo.deps.lookup);
    omo.deps.lookup.get = async () => {
      throw new Error("salle injoignable (essai)");
    };
    t.after(() => {
      omo.deps.lookup.get = lecture;
    });
    const repere = h.fake.requests.length;
    const res = await appel(h, "?instance=omo");
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { error: "opencode-injoignable", message: C.erreurInconnue });
    assert.deepEqual(requetes(h.fake, repere), [], "aucun repli sur l'instance principale");
  });

  it("aucune écriture : base et dossiers de la salle inchangés, que des GET vers les deux instances, aucun redémarrage", async (t) => {
    const { h, omo } = await salleAvancee(t);
    omo.fake.setAgents(agentsDeLaSalle(omo.fake.agents()[0]?.permission));
    const avant = contenuBase(h.db);
    const repereSalle = omo.fake.requests.length;
    const reperePrincipal = h.fake.requests.length;
    assert.equal((await appel(h, "?instance=omo")).status, 200);
    assert.equal((await appel(h, `?instance=omo&directory=${q(`${h.fake.directory}/proj`)}`)).status, 200);
    assert.equal((await appel(h, `?instance=omo&directory=${q(`${h.fake.directory}/${TRAP}`)}`)).status, 403);
    assert.equal(contenuBase(h.db), avant, "l'onglet n'écrit rien en base");
    // Le passage en mode Simple écrit le réglage (le test, pas l'onglet) : la base est relevée de nouveau avant le refus.
    h.settings.update({ ui: { mode: "simple" } });
    const avantSimple = contenuBase(h.db);
    assert.equal((await appel(h, "?instance=omo")).status, 403);
    assert.equal(contenuBase(h.db), avantSimple, "le refus du mode Simple n'écrit rien en base");
    assert.deepEqual(omo.fichiers(), [], "aucun fichier écrit dans les dossiers de la salle");
    for (const [nom, fake, repere] of [
      ["salle", omo.fake, repereSalle],
      ["principale", h.fake, reperePrincipal],
    ] as const) {
      const methodes = [...new Set(fake.requests.slice(repere).map((r) => r.method))];
      assert.ok(methodes.every((m) => m === "GET"), `${nom} : ${JSON.stringify(methodes)}`);
    }
    h.assertNoGlobalRestart();
  });
});

describe("onglet « Salle OMO » : module pur shared/agent-map-omo.ts", () => {
  it("libellé = nom du rôle des textes de la salle, puis la clé ; « Planifier (sisyphus) », « Autres (athena) »", () => {
    assert.equal(libelleAgentDeLaSalle("sisyphus"), "Planifier (sisyphus)");
    assert.equal(libelleAgentDeLaSalle("explore"), "Chercher (explore)");
    assert.equal(libelleAgentDeLaSalle("athena"), "Autres (athena)");
    // Clé comparée sans la casse, comme l'extension ; une clé héritée d'Object n'est jamais un rôle.
    assert.equal(libelleAgentDeLaSalle("Sisyphus"), "Planifier (Sisyphus)");
    assert.equal(libelleAgentDeLaSalle("toString"), "Autres (toString)");
    for (const role of OMO_ROLES) assert.ok(NEON.partout.secteurs[role].length > 0, role);
    assert.deepEqual(Object.keys(NEON.partout.secteurs).sort(), [...OMO_ROLES].sort(), "un secteur des textes de la salle par rôle");
  });

  it("vueDeLaSalle : internes d'opencode, du cockpit et de la liste passée retirés ; doublons retirés ; ordre des rôles puis des clés ; borne", () => {
    assert.deepEqual(vueDeLaSalle(agentsDeLaSalle().map((a) => a.name), INTERNAL_AGENTS), ATTENDU);
    // Liste des internes passée en entrée (Studio) : un nom qu'elle cite est retiré, même sans préfixe cockpit-.
    assert.deepEqual(
      vueDeLaSalle(["sisyphus", "maison"], ["maison"]).agents.map((a) => a.cle),
      ["sisyphus"],
    );
    assert.deepEqual(vueDeLaSalle(["", "summary", "cockpit-classifier"], []).agents, []);
    const beaucoup = Array.from({ length: SALLE_AGENTS_MAX + 20 }, (_, i) => `maison-${String(i).padStart(4, "0")}`);
    assert.equal(vueDeLaSalle(beaucoup, []).agents.length, SALLE_AGENTS_MAX);
  });

  it("module pur : ni « node: » ni process ; imports : agent-choice, neon-texts, omo-roles ; aucune phrase ni rôle écrits", () => {
    const source = lire("server/shared/agent-map-omo.ts");
    assert.equal(source.includes('"node:'), false);
    assert.equal(/\bprocess\./.test(source), false);
    const imports = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]).sort();
    assert.deepEqual(imports, ["./agent-choice.ts", "./neon-texts.ts", "./omo-roles.ts"]);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const litteraux = [...code.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)].map((m) => (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, ""));
    for (const litteral of litteraux) assert.match(litteral, /^[a-z0-9:*._/ ()-]*$/, litteral);
    for (const libelle of Object.values(NEON.partout.secteurs)) assert.equal(code.includes(libelle), false, libelle);
  });
});

// --- Interface --------------------------------------------------------------------------------------------------------------------

/** Texte sans commentaires (lignes « // », blocs « /* * / » et « {/* * /} » du JSX). */
const sansCommentaires = (texte: string) => texte.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Chaînes de rôle interdites dans la vue : noms des secteurs des textes de la salle, codes des rôles, « orchestrateur ». */
const CHAINES_DE_ROLE: readonly string[] = [...Object.values(NEON.partout.secteurs), ...OMO_ROLES.filter((role) => role !== "autres"), "Orchestrat"];

/** Chaînes de rôle trouvées dans un source de vue (commentaires ignorés). */
function chainesDeRole(source: string): string[] {
  const code = sansCommentaires(source);
  return CHAINES_DE_ROLE.filter((chaine) => new RegExp(`(?<![\\p{L}])${chaine}`, "iu").test(code));
}

/** Balises de la section l39o:salle-omo : chacune fermée, nommée, jamais dans une section c5: ni dans un bloc de l'itération 4. */
function balisesL39o(source: string): string[] {
  const problemes: string[] = [];
  const IT4 = new RegExp("équipes \\(it4\\)\\s*:\\s*(début|fin)", "g");
  const jetons = [
    ...[...source.matchAll(/<(\/?)l39o:([\w-]+)>/g)].map((m) => ({ at: m.index ?? 0, genre: "l39o", ferme: m[1] === "/", nom: m[2] ?? "" })),
    ...[...source.matchAll(/<(\/?)c5:([\w-]+)>/g)].map((m) => ({ at: m.index ?? 0, genre: "c5", ferme: m[1] === "/", nom: m[2] ?? "" })),
    ...[...source.matchAll(IT4)].map((m) => ({ at: m.index ?? 0, genre: "it4", ferme: m[1] === "fin", nom: "it4" })),
  ].sort((a, b) => a.at - b.at);
  let ouverte: { genre: string; nom: string } | null = null;
  for (const jeton of jetons) {
    if (jeton.genre === "l39o" && jeton.nom !== "salle-omo") problemes.push(`nom inattendu : ${jeton.nom}`);
    if (!jeton.ferme) {
      if (ouverte !== null && (ouverte.genre === "l39o" || jeton.genre === "l39o")) problemes.push(`imbrication : ${jeton.genre}:${jeton.nom} dans ${ouverte.genre}:${ouverte.nom}`);
      ouverte = { genre: jeton.genre, nom: jeton.nom };
    } else {
      if (ouverte === null || ouverte.genre !== jeton.genre || ouverte.nom !== jeton.nom) problemes.push(`fermeture sans ouverture : ${jeton.genre}:${jeton.nom}`);
      ouverte = null;
    }
  }
  if (ouverte !== null) problemes.push(`non fermée : ${ouverte.genre}:${ouverte.nom}`);
  return problemes;
}

/** Retire les sections l39o:salle-omo (TS et JSX) d'un source : ce qui reste doit être le code d'avant le paquet. */
const horsSectionsL39o = (source: string) =>
  source.replace(/(\/\/|\{\/\*) <l39o:salle-omo>( \*\/\})?[\s\S]*?(\/\/|\{\/\*) <\/l39o:salle-omo>( \*\/\})?/g, "");

describe("onglet « Salle OMO » : interface et textes", () => {
  it("CarteSalleOmo.tsx : aucune chaîne de rôle écrite, libellés du serveur, « Salle coupée » de la salle, textes de la carte seulement", () => {
    const source = fs.readFileSync(path.join(CARTE, "CarteSalleOmo.tsx"), "utf8");
    assert.equal((source.split("\n")[0] ?? "").replace(/\r$/, ""), "// Propriétaire : L39o.");
    assert.deepEqual(chainesDeRole(source), []);
    // Contrôle discriminant : un rôle écrit dans la vue serait trouvé.
    assert.ok(chainesDeRole(`${source}\nconst x = "Planifier";`).includes("Planifier"));
    assert.ok(chainesDeRole(`${source}\nconst x = "executer";`).includes("executer"));
    assert.deepEqual(chainesDeRole("<span>Orchestrateur (Sisyphus)</span>"), ["Orchestrat"]);
    const code = sansCommentaires(source);
    assert.match(code, /\{agent\.libelle\}/);
    assert.match(code, /\{TEXTES_SALLE\.avance\.etats\.coupee\}/);
    assert.match(code, /import \{ TEXTES \} from "\.\.\/\.\.\/\.\.\/\.\.\/server\/shared\/agent-map-texts\.ts";/);
    assert.match(code, /import \{ TEXTES as TEXTES_SALLE \} from "\.\.\/\.\.\/\.\.\/\.\.\/server\/shared\/omo-room-texts\.ts";/);
    // Lecture seule : un seul appel, celui du client de la carte ; aucun fetch, aucune écriture, aucune animation.
    assert.match(code, /agentMapApi\.salle\(\{ directory \}\)/);
    assert.equal(/\bfetch\s*\(|http\.|agentMapApi\.(?!salle\b)\w+|\.post\(|\.put\(|\.del\(/.test(code), false);
    assert.equal(/animation|transition|autoFocus|\.focus\(|tabIndex/.test(code), false);
    // Aucun texte écrit : aucune chaîne littérale avec une espace et une lettre accentuée ou une majuscule suivie d'une minuscule.
    const suspects = [...code.matchAll(/"([^"\n]*)"/g)].map((m) => m[1] ?? "").filter((v) => /\s/.test(v) && (/[À-ÿ]/.test(v) || /[A-ZÀ-Ý][a-zà-ÿ]/.test(v)));
    assert.deepEqual(suspects, []);
    const texteJsx = [...code.matchAll(/>([^<>{}]+)</g)].map((m) => (m[1] ?? "").trim()).filter((v) => /\p{L}/u.test(v));
    assert.deepEqual(texteJsx, [], "aucun texte entre deux balises JSX");
  });

  it("CarteTab.tsx : onglet monté en mode Avancé seulement, retour à la carte principale en Simple", () => {
    const tab = fs.readFileSync(path.join(CARTE, "CarteTab.tsx"), "utf8");
    const code = sansCommentaires(tab);
    assert.match(code, /const salleMontree = advanced && salleChoisie;/);
    assert.match(code, /\{advanced \? <ChoixCarte salle=\{false\} onChoisir=\{setSalle\} \/> : null\}/);
    assert.match(code, /if \(salleMontree\) \{\s*return \(/);
    // CarteSalleOmo n'est monté qu'une fois, dans le rendu de l'onglet (derrière salleMontree).
    assert.equal((code.match(/<CarteSalleOmo\b/g) ?? []).length, 1);
    assert.match(
      code,
      /if \(salleMontree\) \{\s*return \(\s*<div className="ca-onglet stack loose">[\s\S]*?<CarteSalleOmo directory=\{directory\} \/>\s*<\/div>\s*\);\s*\}/,
      "CarteSalleOmo dans le bloc de salleMontree",
    );
    // Contrôle discriminant : sans « advanced && », la garde tombe.
    const mute = code.replace("const salleMontree = advanced && salleChoisie;", "const salleMontree = salleChoisie;");
    assert.notEqual(mute, code);
    assert.doesNotMatch(mute, /const salleMontree = advanced && salleChoisie;/);
    // Les boutons de l'onglet restent le DEUXIÈME enfant de l'onglet dans les deux rendus (le focus reste sur le bouton pressé).
    assert.match(code, /<header className="ca-entete">[\s\S]*?<\/header>\s*<ChoixCarte salle=\{true\} onChoisir=\{setSalle\} \/>/);
    assert.match(code, /<\/header>\s*\{advanced \? <ChoixCarte salle=\{false\}/);
  });

  it("CarteTab.tsx : sections l39o:salle-omo appariées, jamais imbriquées ; section c5:vue-ensemble de L48 intacte ; tout l'ajout dans les sections", () => {
    const tab = fs.readFileSync(path.join(CARTE, "CarteTab.tsx"), "utf8");
    assert.deepEqual(balisesL39o(tab), []);
    // Contrôles discriminants : imbrication et oubli de fermeture trouvés. Les balises c5 et les bornes de l'itération 4 sont
    // citées en morceaux : le test des balises du dépôt (construction-balises.test.ts) ne doit pas les lire comme des sections de
    // ce fichier (même précaution qu'agent-map-overview.test.ts).
    assert.ok(balisesL39o("// <" + "c5:a>\n// <l39o:salle-omo>\n// </l39o:salle-omo>\n// </" + "c5:a>\n").length > 0);
    assert.ok(balisesL39o("// <l39o:salle-omo>\n").length > 0);
    const it4 = (borne: string) => `// --- équipes (it4) : ${borne} ---\n`;
    assert.ok(balisesL39o(`${it4("début")}// <l39o:salle-omo>\n// </l39o:salle-omo>\n${it4("fin")}`).length > 0);
    assert.ok((tab.match(/<l39o:salle-omo>/g) ?? []).length >= 4);
    // Section de L48 : ses six blocs sont là, avec leur contenu vérifié par agent-map-overview.test.ts.
    assert.equal((tab.match(/<[c]5:vue-ensemble>/g) ?? []).length, 6);
    assert.equal((tab.match(/<\/[c]5:vue-ensemble>/g) ?? []).length, 6);
    // Hors des sections du paquet, plus rien ne nomme l'onglet de la salle : tout l'ajout y est.
    const dehors = sansCommentaires(horsSectionsL39o(tab));
    assert.equal(/salle|Salle|ChoixCarte/.test(dehors), false);
    assert.match(dehors, /<CarteListe result=\{data\} advanced=\{advanced\} element=\{montre\} onChoisir=\{choisir\} \/>/);
  });

  it("fichiers partagés du paquet : sections l39o:salle-omo appariées ; hors sections, rien de la salle", () => {
    for (const fichier of ["server/routes-agent-map.ts", "server/agent-map-service.ts", "server/shared/agent-map-texts.ts", "web/lib/api-agent-map.ts"]) {
      const source = lire(fichier);
      assert.deepEqual(balisesL39o(source), [], fichier);
      assert.ok((source.match(/<l39o:salle-omo>/g) ?? []).length >= 1, fichier);
      const dehors = sansCommentaires(horsSectionsL39o(source));
      assert.equal(/buildSalle|agent-map-omo|omo-room-texts|instance=omo|estSalleCoupee|\bsalle\b/.test(dehors), false, fichier);
    }
  });

  it("client : un seul appel de GET /api/agent-map, partagé ; l'onglet envoie instance=omo, la carte principale n'envoie aucune instance", () => {
    const source = lire("web/lib/api-agent-map.ts");
    assert.equal((source.match(/http\.(get|post|put|del)</g) ?? []).length, 1);
    assert.match(source, /salle: \(params: \{ directory\?: string \| null \} = \{\}, signal\?: AbortSignal\) =>\s*lireLaCarte<AgentMapSalleResult>\(\{ instance: "omo", directory: params\.directory \?\? null \}, signal\)/);
    assert.match(source, /get: \([^)]*\) =>\s*lireLaCarte<AgentMapResult>\(\{ directory: params\.directory \?\? null, element: params\.element \?\? null \}, signal\)/);
  });

  it("textes de l'onglet : en mode Avancé seulement, dans agent-map-texts.ts ; aucun nom de rôle ni « Salle coupée » réécrit", () => {
    const S = TEXTES.avance.salle;
    assert.equal(S.onglet, "Salle OMO");
    // Salle réservée au mode Avancé : ni « Salle OMO » ni « OMO » dans les textes des deux modes ou du mode Simple.
    const partoutEtSimple = JSON.stringify([TEXTES.partout, TEXTES.simple]);
    assert.equal(/Salle OMO|\bOMO\b/.test(partoutEtSimple), false);
    const feuilles = Object.values(S);
    for (const texte of feuilles) {
      for (const libelle of Object.values(NEON.partout.secteurs)) assert.equal(texte.includes(libelle), false, `${texte} : ${libelle}`);
      assert.equal(texte.includes(SALLE.avance.etats.coupee), false, texte);
    }
  });
});
