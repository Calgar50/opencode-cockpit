// Tests L12c (spécification §7.1 « différé = direct », §4.12, §5.4, §5.5, §5.6, §3.6, §3.11, P7, P12 ; plan d'exécution, fiche
// L12c). Deux parties :
// 1. Rejeu : la fixture `autonomie-p8.jsonl` (L10a) jouée sur le cockpit réel écrit des faits `decision` et `choix` ; les faits
//    reçus EN DIRECT (activite.fait, sérialisés comme le navigateur les reçoit) et les faits RELUS en différé (GET …/facts)
//    donnent, au fait près, le même état du réducteur d'activité (L4c) et la même scène néon (L5a), à toute heure, dans les deux
//    modes et les deux zooms. P12 : chaque signe de décision de la scène cite un fait enregistré, et chaque ligne du Journal du
//    contrôle a son fait.
// 2. Interface (lecture des sources, sans navigateur, comme agent-choice.test.ts et web-animations.test.ts) : le Journal est un
//    `<table>` aux colonnes exactes du §4.12, ses libellés viennent tous de server/shared/autonomy-texts.ts (L9b), sa règle et sa
//    raison s'atteignent au clavier ; le Déroulé garde le Prévu / Réel, le [Tableau] et la phrase de L5t ; le Diagnostic montre
//    l'interrupteur, la porte I1, l'IA de contrôle et l'installation gardée ; les plafonds des Paramètres sont réglables dans les
//    deux modes ; aucun mot interdit en mode Simple, « étape » jamais accolé au nombre `steps`, aucune animation, `forced-colors`
//    et 400 px tenus ; les deux variantes de `budget.autonomie.controleIa` donnent bien deux textes (décision n° 8).
// Aucun appel facturé : faux opencode seulement.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { ActivationPort, PermissionGate } from "./contracts-11.ts";
import type { AppDeps } from "./http.ts";
import { createPermissionGate } from "./permission-gate.ts";
import { SessionTracker } from "./sessions.ts";
import { DEFAULT_SETTINGS, settingsSchema } from "./settings.ts";
import {
  type ActivityState,
  activityStatus,
  applyEvent,
  emptyActivity,
  liveRows,
  replayFacts,
  timeline,
  totals,
} from "./shared/activity.ts";
import type { ActivityFact, FactsResponse } from "./shared/activity-types.ts";
import { libelleDecision, libellePar, phraseRegle, TEXTES } from "./shared/autonomy-texts.ts";
import { type NeonMode, type NeonZoom, scene } from "./shared/neon-scene.ts";
import { startCockpit } from "./test-support/cockpit-harness.ts";
import { readCapture } from "./test-support/fake-opencode.ts";
import { until } from "./test-support/helpers.ts";

const FIXTURE = "autonomie-p8.jsonl";
const APP_DIR = path.join(import.meta.dirname, "..");
const NL = String.fromCharCode(10);

/** Port `activation` ouvert par surcharge (ACTIVATION_OUVERTE n'est jamais touchée, plan §2.6). */
const PERMIS: ActivationPort = { check: async () => ({ ok: true }) };

/** Portillon réel dont le relais répond « ok » : un rejeu n'a aucune demande vivante chez opencode (comme la fixture de L10a). */
const RELAIS_OK = (deps: AppDeps): PermissionGate => {
  const real = createPermissionGate({ client: deps.client, db: deps.db, log: deps.log, hub: deps.hub, sessions: new SessionTracker(deps.db, deps.client) });
  return { ...real, relayOnce: async () => "ok" };
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const TAB = String.fromCharCode(9);
const DQ = String.fromCharCode(34);
/** Dossier de travail du rejeu, identique à celui de la fixture chez L10a : `proj` est le dossier de la conversation. */
function workspace(t: TestContext): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-l12c-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const proj = path.join(root, "proj");
  for (const dir of ["src", ".git/objects", ".git/refs"]) fs.mkdirSync(path.join(proj, ...dir.split("/")), { recursive: true });
  const files: Record<string, string> = {
    "README.md": `# Projet${NL}`,
    "src/app.ts": `// TODO${NL}`,
    "src/a.ts": `export {};${NL}`,
    "a.txt": `ligne 1${NL}ligne 2${NL}`,
    ".git/HEAD": `ref: refs/heads/main${NL}`,
    ".git/config": [
      "[core]",
      `${TAB}repositoryformatversion = 0`,
      `${TAB}filemode = true`,
      `${TAB}bare = false`,
      `[remote ${DQ}origin${DQ}]`,
      `${TAB}url = https://example.invalid/depot.git`,
      "",
    ].join(NL),
  };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(proj, ...name.split("/")), content);
  return root;
}

/** Événement `session.created` de la capture et la session qu'il porte. */
function capturedRoot(): { wire: ReturnType<typeof readCapture>[number]["wire"]; id: string } {
  const capture = readCapture(FIXTURE);
  const created = capture.find(({ wire }) => "payload" in wire && !("syncEvent" in wire.payload) && wire.payload.type === "session.created");
  assert.ok(created && "payload" in created.wire && !("syncEvent" in created.wire.payload), "la capture crée une conversation");
  const properties = created.wire.payload.properties;
  assert.ok(isRecord(properties) && isRecord(properties.info) && typeof properties.info.id === "string");
  return { wire: created.wire, id: properties.info.id };
}

interface Rejeu {
  /** Faits publiés en direct, sérialisés comme le navigateur les reçoit. */
  direct: ActivityFact[];
  /** Faits relus par la route de L4b (différé). */
  differe: ActivityFact[];
  rootId: string;
  decisions: Array<{ permission_id: string | null; verdict: string; regle: string }>;
}

/**
 * Joue la fixture sur le cockpit réel (modules autonomy, requests, facts, floors et conversationAutonomy) : un choix par la vraie
 * route L6a, la capture, puis un retour à « Demander ». Rend les faits vus en direct et relus en différé.
 */
async function rejouer(t: TestContext): Promise<Rejeu> {
  const workspaceDir = workspace(t);
  const h = await startCockpit(t, {
    modules: ["autonomy", "requests", "facts", "floors", "conversationAutonomy"],
    env: { workspaceDir },
    settings: { ui: { mode: "simple" }, budget: { autonomie: { controleIa: true, actionsMax: 1 } } },
    ports: { activation: PERMIS },
    gate: RELAIS_OK,
  });
  const root = capturedRoot();

  // La conversation de la capture est celle de la fixture : le cockpit la découvre par son événement de création.
  h.fake.emitRaw(root.wire);
  await until(() => h.sessions.get(root.id));

  // Choix par la route réelle (fait « choix » {autonome, clic}), puis demande autonome ouverte à la main : la capture ne rejoue
  // pas l'envoi du proxy.
  const url = `/api/conversations/${root.id}/autonomie`;
  const ouvert = await h.call("PUT", url, { headers: h.headers.confirmed, body: { choix: "autonome" } });
  assert.equal(ouvert.status, 200, ouvert.body);
  h.db
    .prepare("INSERT INTO autonomy_requests (id, root_id, choix, plafonds, started_at) VALUES ('p8', ?, 'autonome', ?, ?)")
    .run(root.id, JSON.stringify({ plafondUsd: 1, actionsMax: 1, delegationsMax: 5, dureeMinutes: 30, fichiersMax: 25, controlesIaMax: 20 }), Date.now());

  for (const { wire } of readCapture(FIXTURE)) h.fake.emitRaw(wire);
  const decisions = await until(
    () => {
      const rows = h.db.prepare("SELECT permission_id, verdict, regle FROM autonomy_decisions ORDER BY id").all() as Array<{
        permission_id: string | null;
        verdict: string;
        regle: string;
      }>;
      return rows.length === 4 ? rows : null;
    },
    8_000,
  );

  // Retour à « Demander à chaque fois » : second fait « choix », après les décisions.
  const resserre = await h.call("PUT", url, { headers: h.headers.mutating, body: { choix: "demander" } });
  assert.equal(resserre.status, 200, resserre.body);

  // Direct : ce que le navigateur reçoit du flux, JSON compris (aucun objet partagé avec le serveur).
  const direct = h.cockpitEvents()
    .filter((event) => event.type === "activite.fait")
    .map((event) => JSON.parse(JSON.stringify(event.data)) as ActivityFact)
    .filter((fact) => fact.rootId === root.id);

  // Différé : la route de L4b, telle que le Déroulé la lit à l'ouverture d'un onglet.
  const relu = await h.call("GET", `/api/conversations/${root.id}/facts?since=0`, { headers: h.headers.authed });
  assert.equal(relu.status, 200, relu.body);
  const body = relu.json<FactsResponse>();
  assert.equal(body.partial, false, "aucune borne de faits atteinte par la fixture");
  h.assertNoGlobalRestart();
  return { direct, differe: body.facts, rootId: root.id, decisions };
}

/** État du réducteur construit fait par fait, comme le flux du navigateur le fait. */
function etatDirect(rootId: string, facts: readonly ActivityFact[]): ActivityState {
  let state = emptyActivity(rootId);
  for (const fact of facts) state = applyEvent(state, { kind: "cockpit", type: "activite.fait", data: fact });
  return state;
}

/** Lecture d'un fichier de l'interface, chemin relatif à `app/`. */
const lire = (...segments: string[]): string => fs.readFileSync(path.join(APP_DIR, ...segments), "utf8");

/** Source sans ses commentaires : ce que le composant affiche vraiment. */
const sansCommentaires = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/[^\n]*$/gm, " ");

const JOURNAL_TSX = ["web", "pages", "chat", "autonomy", "ControlJournal.tsx"];
const JOURNAL_CSS = ["web", "pages", "chat", "autonomy", "autonomy-journal.css"];
const DEROULE_TSX = ["web", "pages", "chat", "activity", "Deroule.tsx"];
const DIAGNOSTIC_TSX = ["web", "pages", "diagnostics", "AutonomyDiagnostics.tsx"];
const BUDGET_TSX = ["web", "pages", "settings", "BudgetTab.tsx"];

// --- 1. « Différé = direct » (§7.1, P12) ------------------------------------------------------------------------------------------

describe("L12c : « différé = direct » des décisions et des choix (autonomie-p8)", () => {
  it("mêmes faits, même état et même scène, en direct et relus", async (t) => {
    const { direct, differe, rootId, decisions } = await rejouer(t);

    // Les quatre situations de la fixture, plus les deux choix : le rejeu porte bien des décisions ET des choix.
    assert.deepEqual(
      decisions.map((row) => [row.verdict, row.regle]),
      [
        ["attente", "E2"],
        ["attente", "S7"],
        ["auto", "A-pwd"],
        ["attente", "plafond-actions"],
      ],
    );
    const kinds = (facts: readonly ActivityFact[], kind: string) => facts.filter((fact) => fact.kind === kind);
    // Invariant général (§7.4, D-01), et non le seul compte de cette fixture : TOUT écrivain du Journal (L10a comme L10c) pose
    // son fait, sans quoi le Déroulé ne lit jamais la ligne qu'il vient d'écrire.
    assert.equal(kinds(direct, "decision").length, decisions.length, "un fait « decision » par ligne du journal");
    assert.deepEqual(
      kinds(direct, "choix").map((fact) => [fact.data.choix, fact.data.cause]),
      [
        ["autonome", "clic"],
        ["demander", "clic"],
      ],
    );

    // Au fait près : même liste, même ordre, mêmes données.
    assert.deepEqual(differe, direct, "faits relus = faits publiés");

    const a = etatDirect(rootId, direct);
    const b = replayFacts(emptyActivity(rootId), differe);
    assert.deepEqual(b.facts, a.facts);
    assert.deepEqual(activityStatus(b), activityStatus(a));
    assert.deepEqual(timeline(b), timeline(a));
    assert.deepEqual(totals(b), totals(a));
    const fin = Math.max(...direct.map((fact) => fact.at)) + 1;
    for (const t0 of [null, direct[0]?.at ?? 0, fin]) {
      assert.deepEqual(liveRows(b, t0 ?? fin), liveRows(a, t0 ?? fin), `lignes d'acteur (t=${String(t0)})`);
    }

    // Scène néon : même entrée, même scène, à toute heure, dans les deux modes et tous les zooms (§5.7.1).
    for (const mode of ["simple", "avance"] as NeonMode[]) {
      for (const zoom of [2, 3] as NeonZoom[]) {
        for (const t0 of [null, ...direct.map((fact) => fact.at)]) {
          const gauche = scene(a.facts, t0, { zoom, mode });
          const droite = scene(b.facts, t0, { zoom, mode });
          assert.deepEqual(droite, gauche, `scène ${mode} zoom ${zoom} (t=${String(t0)})`);
        }
      }
    }

    // P12 : chaque signe de décision de la scène cite des faits de la liste, et ce sont des faits « decision ».
    const scene0 = scene(a.facts, null, { zoom: 2, mode: "avance" });
    assert.ok(scene0.decisions.length > 0, "la scène montre les décisions de la fixture");
    for (const signe of scene0.decisions) {
      assert.ok(signe.faits.length > 0, "aucun signe sans fait");
      for (const index of signe.faits) {
        const fait = a.facts[index];
        assert.ok(fait, `fait ${index} présent`);
        assert.ok(["decision", "attente"].includes(fait.kind), `fait ${index} : ${fait?.kind}`);
      }
    }

    // Contre-épreuve : sans les faits « decision », la scène change. La comparaison ci-dessus est donc discriminante.
    const ampute = replayFacts(emptyActivity(rootId), direct.filter((fact) => fact.kind !== "decision"));
    assert.notDeepEqual(scene(ampute.facts, null, { zoom: 2, mode: "avance" }).decisions, scene0.decisions);
    // Contre-épreuve du choix : sans les faits « choix », l'état ne dit plus le retour à « Demander ».
    const sansChoix = replayFacts(emptyActivity(rootId), direct.filter((fact) => fact.kind !== "choix"));
    assert.notDeepEqual(activityStatus(sansChoix).choix, activityStatus(a).choix);
  });
});

// --- 2. Journal du contrôle (§4.12, §5.4, §5.5) -----------------------------------------------------------------------------------

describe("L12c : Journal du contrôle", () => {
  it("tableau aux colonnes du §4.12, état vide et libellés pris dans autonomy-texts (L9b)", () => {
    const source = lire(...JOURNAL_TSX);
    assert.match(source, /<table/, "le Journal est un <table> (§5.5)");
    assert.match(source, /<caption/, "le tableau porte un libellé");
    for (const [cle, colonne] of Object.entries(TEXTES.partout.journal.colonnes)) {
      assert.ok(source.includes(`JOURNAL.colonnes.${cle}`), `colonne ${cle} rendue depuis les textes (« ${colonne} »)`);
    }
    // Les huit colonnes exactes du §4.12, dans l'ordre.
    assert.deepEqual(Object.values(TEXTES.partout.journal.colonnes), [
      "Heure",
      "Qui",
      "Action",
      "Décision",
      "Par",
      "Règle",
      "Raison",
      "Coût du contrôle",
    ]);
    for (const fonction of ["libelleDecision", "libellePar", "phraseRegle", "montant"]) {
      assert.ok(source.includes(`${fonction}(`), `${fonction} utilisé : aucune phrase réécrite dans le composant`);
    }
    // État vide (§5.4) : la phrase exacte de la spécification, écrite par le Déroulé qui sait de quelle fenêtre il parle ; le
    // module de textes (L9b) sert de repli. Les deux sont contrôlés : la phrase du §5.4 ne doit jamais disparaître de la vue.
    assert.ok(source.includes("vide ?? JOURNAL.vide"), "état vide : phrase de l'appelant, repli sur les textes");
    assert.match(lire(...DEROULE_TSX), /vide=\{`Aucune décision automatique pour \$\{scope\}\.`\}/, "phrase du §5.4");
    const code = sansCommentaires(source);
    for (const libelle of [...Object.values(TEXTES.partout.decisions), ...Object.values(TEXTES.partout.par)]) {
      assert.equal(code.includes(libelle), false, `libellé « ${libelle} » écrit en clair dans le composant`);
    }
  });

  it("règle et raison atteignables au clavier, icône accompagnée de son mot", () => {
    const source = lire(...JOURNAL_TSX);
    assert.match(source, /<button[\s\S]{0,400}aria-expanded=\{montre\}/, "chaque repère est un bouton, avec son état déplié");
    assert.match(source, /onFocus=\{\(\) => setFocus/, "la règle et la raison s'affichent au focus (clavier)");
    assert.match(source, /onClick=\{\(\) => setOuvert/, "et restent affichées après un clic");
    assert.match(source, /libelleDecision\(repere\.verdict\)/, "le mot de la décision accompagne l'icône");
    assert.match(source, /regleCarte\(/, "la règle est montrée par sa phrase (« Règle : … »)");
  });

  it("styles : aucune animation, mode contrasté et 400 px", () => {
    const css = lire(...JOURNAL_CSS).replace(/\/\*[\s\S]*?\*\//g, " ");
    assert.equal(/\banimation\s*:/.test(css), false, "aucune animation (§5.5, JP-13)");
    assert.match(css, /@media \(forced-colors: active\)/);
    assert.match(css, /@media \(max-width: 480px\)/, "lisible à 400 px (§5.6)");
    assert.match(css, /focus-visible/, "le focus reste visible");
    assert.match(lire(...JOURNAL_TSX), /className="table-wrap journal-wrap"/, "le tableau défile plutôt que de déborder");
  });
});

// --- 3. Déroulé (§4.12) ------------------------------------------------------------------------------------------------------------

describe("L12c : repères du Déroulé", () => {
  it("repères posés sur les lignes d'acteur, sans toucher au reste de L5t", () => {
    const source = lire(...DEROULE_TSX);
    assert.match(source, /<DecisionMarks decisions=\{decisions\} sessionId=\{row\.sessionId\}/, "un repère par ligne d'acteur");
    assert.ok(source.includes("<ControlJournal"), "le Journal remplace l'emplacement de L5t");
    // Intact : Prévu / Réel, [Tableau], phrase des attentes non enregistrées (L5t).
    assert.ok(source.includes("Temps d'attente non enregistré avant la 1.1"));
    assert.match(source, /<th scope="col">Prévu<\/th>/);
    assert.match(source, /<th scope="col">Réel<\/th>/);
    assert.match(source, /aria-pressed=\{table\}[\s\S]{0,120}Tableau/, "le bouton [Tableau] de L5t est intact");
    assert.match(source, /<td>\{row\.prevu\.text\}<\/td>/, "la colonne Prévu lit toujours plannedOf (L5t)");
  });

  it("le Journal n'est lu que si un fait « decision » existe (P12)", () => {
    const source = lire(...DEROULE_TSX);
    assert.match(source, /useControlDecisions\(rootId, faitsDecision\)/, "aucune lecture sans fait enregistré");
    assert.match(source, /state\.facts\.filter\(\(f\) => f\.kind === "decision"\)\.length/, "le compte vient des faits");
    const journal = lire(...JOURNAL_TSX);
    assert.match(journal, /attendu > 0 \? await activityApi\.activity\(rootId\) : null/, "GET …/activity seulement quand un fait existe");
    assert.equal(/fetch\(|http\.post|http\.put/.test(journal), false, "aucune route nouvelle, aucune écriture");
  });
});

// --- 4. Diagnostic (§3.11) ----------------------------------------------------------------------------------------------------------

describe("L12c : Diagnostic de l'autonomie", () => {
  it("interrupteur, porte I1, IA de contrôle et installation gardée, tous lus dans la réponse du serveur", () => {
    const source = lire(...DIAGNOSTIC_TSX);
    for (const champ of ["data.interrupteur", "data.activationOuverte", "data.controleIa", "data.agentsInternes"]) {
      assert.ok(source.includes(champ), `${champ} lu`);
    }
    assert.ok(source.includes("COCKPIT_AUTONOMY"), "l'interrupteur est nommé en mode Avancé");
    assert.ok(source.includes("etatAgentInterne("), "l'installation est dite avec la phrase de §3.11");
    assert.ok(source.includes('raisonIndisponible("a-venir")'), "porte I1 fermée : la phrase fixée par le contrat");
    assert.ok(source.includes('controleIaIndisponible("desactive")'), "IA de contrôle coupée (décision n° 8)");
    // Le Diagnostic montre un état : il ne déclenche rien (décision (2) du lancement).
    assert.equal(/http\.post|http\.put|api\.[a-z]+\(|fetch\(/.test(source), false, "aucune exécution déclenchée par le Diagnostic");
  });
});

// --- 5. Réglages des plafonds (§3.6) ------------------------------------------------------------------------------------------------

describe("L12c : plafonds des Paramètres", () => {
  it("autonomie et délégation réglables dans les deux modes, dans les bornes du serveur", () => {
    const source = lire(...BUDGET_TSX);
    assert.ok(source.includes("<AutomaticCaps"), "les plafonds sont posés dans l'onglet Budget");
    const bloc = source.slice(source.indexOf("function AutomaticCaps"), source.indexOf("export function BudgetTab"));
    assert.ok(bloc.length > 0);
    assert.equal(/\badvanced\b/.test(bloc), false, "les plafonds ne dépendent pas du mode (SIMPLE_SETTINGS_PATHS)");
    for (const champ of ["plafondUsd", "plafondMaxUsd", "actionsMax", "delegationsMax", "dureeMinutes", "fichiersMax", "controlesIaMax", "controleIa"]) {
      assert.ok(bloc.includes(champ), `budget.autonomie.${champ} réglable`);
    }
    for (const champ of ["maxUsdPerRequest", "maxPerRequest"]) assert.ok(bloc.includes(champ), `budget.delegation.${champ} réglable`);
    assert.ok(bloc.includes("Le plafond proposé dépasse le plafond maximal."), "le cockpit dit ce que le serveur refuserait");
  });

  it("chaque borne proposée est exactement celle du schéma du serveur", () => {
    const bornes = bornesDuSource(lire(...BUDGET_TSX));
    assert.ok(Object.keys(bornes).length >= 8, `bornes lues : ${JSON.stringify(bornes)}`);
    for (const { borne, section, champ } of CHAMPS) {
      const limites = bornes[borne];
      assert.ok(limites, `borne ${borne} déclarée dans BudgetTab`);
      const pas = Number.isInteger(limites.min) && Number.isInteger(limites.max) && limites.max > 50 ? 1 : 0.01;
      // Les deux bouts proposés par l'interface sont acceptés par le serveur…
      for (const valeur of [limites.min, limites.max]) {
        assert.equal(settingsSchema.safeParse(reglages(section, champ, valeur)).success, true, `${section}.${champ} = ${valeur} refusé par le serveur`);
      }
      // … et juste au-delà, le serveur refuse : l'interface ne propose pas plus large que lui.
      for (const valeur of [limites.min - pas, limites.max + pas]) {
        assert.equal(settingsSchema.safeParse(reglages(section, champ, valeur)).success, false, `${section}.${champ} = ${valeur} accepté par le serveur`);
      }
    }
  });
});

/** Bornes déclarées par BudgetTab (constante BORNES), lues dans le source : l'interface et ce test ne peuvent pas diverger. */
function bornesDuSource(source: string): Record<string, { min: number; max: number }> {
  const bloc = source.slice(source.indexOf("const BORNES = {"), source.indexOf("const LIBELLES"));
  const out: Record<string, { min: number; max: number }> = {};
  for (const match of bloc.matchAll(/(\w+): \{ min: (-?[\d.]+), max: (-?[\d.]+)/g)) out[match[1] as string] = { min: Number(match[2]), max: Number(match[3]) };
  return out;
}

/** Plafonds réglables, chacun avec la borne de l'interface qui le gouverne. */
const CHAMPS: ReadonlyArray<{ borne: string; section: "autonomie" | "delegation"; champ: string }> = [
  { borne: "delegationUsd", section: "delegation", champ: "maxUsdPerRequest" },
  { borne: "delegationNombre", section: "delegation", champ: "maxPerRequest" },
  { borne: "plafondUsd", section: "autonomie", champ: "plafondUsd" },
  { borne: "plafondUsd", section: "autonomie", champ: "plafondMaxUsd" },
  { borne: "actionsMax", section: "autonomie", champ: "actionsMax" },
  { borne: "delegationsMax", section: "autonomie", champ: "delegationsMax" },
  { borne: "dureeMinutes", section: "autonomie", champ: "dureeMinutes" },
  { borne: "fichiersMax", section: "autonomie", champ: "fichiersMax" },
  { borne: "controlesIaMax", section: "autonomie", champ: "controlesIaMax" },
];

/** Réglages par défaut avec un seul plafond changé ; le plafond d'arrêt reste sous le plafond maximal, comme le serveur l'exige. */
function reglages(section: "autonomie" | "delegation", champ: string, valeur: number): unknown {
  const budget = structuredClone(DEFAULT_SETTINGS.budget) as unknown as Record<string, Record<string, number>>;
  (budget[section] as Record<string, number>)[champ] = valeur;
  const autonomie = budget.autonomie as Record<string, number>;
  if (champ === "plafondUsd") autonomie.plafondMaxUsd = Math.max(valeur, autonomie.plafondMaxUsd as number);
  if (champ === "plafondMaxUsd") autonomie.plafondUsd = Math.min(valeur, autonomie.plafondUsd as number);
  return { ...DEFAULT_SETTINGS, budget };
}

// --- 6. Textes (§2.2, §2.3 ; décision n° 8) ------------------------------------------------------------------------------------------

describe("L12c : textes", () => {
  it("deux variantes de l'IA de contrôle : deux phrases, jamais la même", () => {
    for (const mode of ["simple", "avance"] as const) {
      const avec = phraseRegle("S7", { mode, controleIa: true });
      const sans = phraseRegle("S7", { mode, controleIa: false });
      assert.notEqual(avec, sans);
      assert.match(avec, /IA de contrôle/);
      assert.match(sans, /coupé/);
    }
    // Les libellés du Journal ne dépendent pas de la variante : une décision se lit pareil dans les deux cas.
    assert.equal(libelleDecision("auto"), "Autorisé automatiquement");
    assert.equal(libellePar("regles"), "règles");
  });

  it("mots interdits en mode Simple : aucun dans les textes des vues de L12c", () => {
    const interdits: Array<[string, RegExp]> = [
      ["agent", /(?<![\p{L}\p{N}_-])agents?(?![\p{L}])/iu],
      ["sous-agent", /(?<![\p{L}\p{N}_])sous-agents?(?![\p{L}])/iu],
      ["session", /(?<![\p{L}\p{N}_-])sessions?(?![\p{L}])/iu],
      ["permission", /(?<![\p{L}\p{N}_-])permissions?(?![\p{L}])/iu],
      ["itération", /(?<![\p{L}\p{N}_-])it[ée]rations?(?![\p{L}])/iu],
      ["boucle", /(?<![\p{L}\p{N}_-])boucles?(?![\p{L}])/iu],
      ["jeton", /(?<![\p{L}\p{N}_-])jetons?(?![\p{L}])/iu],
      ["modèle", /(?<![\p{L}\p{N}_-])mod[èe]les?(?!\s+de\s+réflexion)(?![\p{L}])/iu],
      ["validation", /(?<![\p{L}\p{N}_-])validations?(?![\p{L}])/iu],
      ["réussi", /(?<![\p{L}\p{N}_-])réussie?s?(?![\p{L}])/iu],
    ];
    const steps = /\{[^{}]*\bsteps\b[^{}]*\}[\s ]*(?:\p{L}+[\s ]+)?étapes?/iu;
    // BudgetTab est un fichier PARTAGÉ : seuls les plafonds ajoutés par L12c sont contrôlés ici (le reste vient de la 1.0.x).
    const budget = lire(...BUDGET_TSX);
    const sources: Array<[string[], string]> = [
      [JOURNAL_TSX, lire(...JOURNAL_TSX)],
      [DEROULE_TSX, lire(...DEROULE_TSX)],
      [DIAGNOSTIC_TSX, lire(...DIAGNOSTIC_TSX)],
      [BUDGET_TSX, budget.slice(budget.indexOf("function AutomaticCaps"), budget.indexOf("export function BudgetTab"))],
    ];
    for (const [fichier, source] of sources) {
      for (const texte of textesAffiches(source)) {
        for (const [mot, re] of interdits) assert.equal(re.test(texte), false, `${fichier.at(-1)} : « ${mot} » dans « ${texte} »`);
        assert.equal(steps.test(texte), false, `${fichier.at(-1)} : « étape » accolé à steps dans « ${texte} »`);
      }
    }
  });

  it("le contrôle des textes est discriminant : un mot interdit planté est trouvé", () => {
    const source = `const a = "Choisissez un agent";${NL}<p>Une session par demande</p>`;
    const trouves = textesAffiches(source);
    assert.ok(trouves.some((texte) => /agent/i.test(texte)), JSON.stringify(trouves));
    assert.ok(trouves.some((texte) => /session/i.test(texte)), JSON.stringify(trouves));
  });
});

/**
 * Textes affichables d'un source .tsx : chaînes entre guillemets et texte libre entre balises JSX, commentaires retirés. Un code
 * (minuscules ASCII, chiffres, séparateurs) et une classe CSS ne sont pas des textes.
 */
function textesAffiches(source: string): string[] {
  const sans = sansCommentaires(source);
  const out: string[] = [];
  const garder = (texte: string) => {
    const valeur = texte.trim();
    if (valeur === "" || /^[a-z0-9]+(?:[-_.:/][a-z0-9]+)*$/.test(valeur)) return;
    if (!/\p{L}/u.test(valeur)) return;
    // Code plutôt que texte : identifiant, chemin d'import, classe CSS composée.
    if (/^[\w./-]+$/.test(valeur) && !/\s/.test(valeur)) return;
    out.push(valeur);
  };
  for (const match of sans.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`$\n]*)`/g)) garder(match[1] ?? match[2] ?? match[3] ?? "");
  for (const match of sans.matchAll(/>([^<>{}\n]+)</g)) garder(match[1] ?? "");
  return out;
}
