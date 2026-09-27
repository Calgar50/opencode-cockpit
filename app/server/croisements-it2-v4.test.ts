// Tests de croisement du train it2 V4 (plan d'exécution §2.3, §5.2 ; propriété de l'intégrateur) : L13 (e2e de l'itération 2) et
// DOC2 (documentation de l'itération 2), posés par les corrections de la relecture « 2-vague-4 ». Ce que la vague doit prouver, et
// qu'aucun paquet ne peut prouver seul — les trois constats venaient tous d'un document qui annonçait autre chose que la branche :
//   1. gardes d'isolation du banc : le nombre annoncé par le §10 du RECAPITULATIF est celui que `run-e2e.sh --gardes` joue sur
//      CETTE branche (51 depuis l'intégration de la 1.0.5, qui apporte les gardes HTTPS de R105b ; 30 avant elle) ;
//   2. témoin P6 et P4 : chaque scénario `it2-*` qui agit sur opencode tourne sous `avecTemoinP6`, sauf une liste FIGÉE de trois
//      exemptés qui n'ont que le journal des requêtes du faux (`exigerP6SurRequetes`, muet hors « --faux ») ; `e2e/README.md` les
//      nomme et dit ce qu'ils ne vérifient pas ;
//   3. confirmation d'un choix automatique : le README et le §10 disent ce que fait `guardAutomatic`, à savoir une confirmation à
//      CHAQUE relâchement pour les deux choix automatiques — la ligne `conversation_autonomy` ne garde aucune trace d'une
//      confirmation déjà donnée, et l'écart avec le §4.11 de la spécification est porté au §11 comme un reste.
// Le banc e2e lui-même (run-e2e.sh) est joué par l'intégrateur, hors de npm test (décision D-06) : ce fichier ne lit que ses
// sources. Aucun appel facturé : faux opencode seulement.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { capWatchModuleWith } from "./autonomy-watch.ts";
import type { Cockpit11Module, ModuleName } from "./contracts-11.ts";
import type { ConversationAutonomyView } from "./shared/autonomy-types.ts";
import { type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakeSession } from "./test-support/fake-opencode.ts";
import { until, within } from "./test-support/helpers.ts";
import { MODULE_ORDER } from "./wiring-11.ts";

const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const DQ = String.fromCharCode(34);

const APP_DIR = path.join(import.meta.dirname, "..");
const REPO_DIR = path.join(APP_DIR, "..");
const SCENARIOS_DIR = path.join(REPO_DIR, "e2e", "scenarios");
const BANC_FILE = path.join(REPO_DIR, "e2e", "lib", "docker-e2e.mjs");
const E2E_README = path.join(REPO_DIR, "e2e", "README.md");
const RECAP = path.join(REPO_DIR, "docs", "RECAPITULATIF.md");
const README = path.join(REPO_DIR, "README.md");

const lire = (file: string) => fs.readFileSync(file, "utf8");
/** Le document sur une seule ligne : les phrases des documents sont coupées à 140 colonnes. */
const aplati = (file: string) => lire(file).replace(/\s+/g, " ");
/** La puce ou la ligne de tableau qui commence par `debut` : les §11 et les tableaux tiennent une entrée par ligne. */
function entree(file: string, debut: string): string {
  const ligne = lire(file)
    .split(/\r?\n/)
    .find((l) => l.startsWith(debut));
  assert.ok(ligne, `${path.basename(file)} : aucune entrée « ${debut} »`);
  return ligne;
}

// --- 1. Gardes d'isolation du banc : le chiffre annoncé est celui de la branche ---------------------------------------------------

describe("croisements it2 V4 : gardes d'isolation du banc (L13, DOC2)", () => {
  it("le §10 du RECAPITULATIF annonce le nombre de gardes que `run-e2e.sh --gardes` joue sur cette branche", () => {
    // Une garde = un `await refuse(…)`, `await verifier(…)` ou `await refusCertificat(…)` de `verifierGardes()`, en tête de ligne
    // (les `verifier`/`refuse` internes de ces enveloppes sont indentés plus loin) : c'est exactement ce que le banc imprime en
    // « ok » ou en « ÉCHEC ». `refusCertificat` est arrivé avec les gardes HTTPS de R105b (intégration de la 1.0.5) : sans elle,
    // ses six gardes manquaient au compte et le §10 semblait annoncer trop.
    const gardes = lire(BANC_FILE)
      .split(/\r?\n/)
      .filter((line) => /^ {2}await (?:refuse|verifier|refusCertificat)\(/.test(line));
    assert.ok(gardes.length > 20, `gardes relevées dans e2e/lib/docker-e2e.mjs : ${gardes.length}`);

    const annonces = [...lire(RECAP).matchAll(/gardes(?: d'isolation)? du banc : (\d+)/g)].map((m) => Number(m[1]));
    assert.ok(annonces.length >= 2, `annonces du RECAPITULATIF : ${annonces.join(", ")}`);
    assert.deepEqual(
      annonces.filter((n) => n !== gardes.length),
      [],
      `le RECAPITULATIF annonce ${annonces.join(", ")} garde(s) ; le banc de cette branche en joue ${gardes.length}`,
    );
  });

  it("le chiffre des gardes HTTPS reste rattaché à ce qui les apporte (R105b, la 1.0.5)", () => {
    const recap = aplati(RECAP);
    // Depuis l'intégration de la 1.0.5, puis R106-b (réglage de mouvement) et les corrections de la répétition générale F1
    // (seconde connexion de la 3D, --autonomie-coupee), les 57 gardes sont jouées ici ; la phrase doit toujours dire d'où
    // viennent celles qui se sont ajoutées aux 30 de l'itération 2, sans quoi le chiffre change sans explication. Au moins une
    // phrase porte ce chiffre : sans elle, le contrôle ne vérifierait plus rien.
    const phrases = [...recap.matchAll(/57 gardes[^.]*\./g)].map((m) => m[0]);
    assert.ok(phrases.length >= 1, "aucune phrase « 57 gardes » dans le RECAPITULATIF");
    for (const phrase of phrases) {
      assert.match(phrase, /R105b|1\.0\.5/, `« ${phrase} » sans sa condition`);
      assert.match(phrase, /R106-b/, `« ${phrase} » sans les gardes du réglage de mouvement`);
      assert.match(phrase, /répétition générale F1/, `« ${phrase} » sans les gardes des corrections de la répétition générale F1`);
    }
  });
});

// --- 2. Témoin P6 et P4 des scénarios de l'itération 2 -----------------------------------------------------------------------------

/**
 * Les SEULS scénarios `it2-*` qui agissent sur opencode hors du témoin complet. Liste figée, comme celle de l'écart D-05 : tout
 * nouveau scénario qui voudrait s'en passer doit être ajouté ici ET nommé dans `e2e/README.md`.
 * - `it2-ui-onglet-ferme.mjs` : exempté par sa démonstration même (aucun flux du cockpit ouvert) ;
 * - `it2-api-interrupteur.mjs` et `it2-ui-selecteur-clavier.mjs` : à reprendre (reste consigné au §11 du RECAPITULATIF).
 */
const EXEMPTES_DU_TEMOIN = ["it2-api-interrupteur.mjs", "it2-ui-onglet-ferme.mjs", "it2-ui-selecteur-clavier.mjs"] as const;

describe("croisements it2 V4 : témoin P6 et P4 du banc (L13, DOC2)", () => {
  const scenarioSource = (name: string) => fs.readFileSync(path.join(SCENARIOS_DIR, name), "utf8");
  /** Agit sur opencode : conversation créée, message envoyé (proxy /api/oc/…), plan créé. Même mesure que pour l'itération 1. */
  const AGIT = /\bcreerConversation\(|\benvoyer\(|\/api\/oc\/|\/api\/plans\b/;
  const agissants = () =>
    fs
      .readdirSync(SCENARIOS_DIR)
      .filter((name) => /^it2-.*\.mjs$/.test(name) && !name.endsWith("-commun.mjs"))
      .filter((name) => AGIT.test(scenarioSource(name)));

  it("chaque scénario it2 qui agit sur opencode tourne sous avecTemoinP6, sauf les trois exemptés de la liste figée", () => {
    const touchent = agissants();
    for (const name of ["it2-api-plafond.mjs", "it2-ui-plan-autonome.mjs", ...EXEMPTES_DU_TEMOIN]) {
      assert.ok(touchent.includes(name), `${name} agit sur opencode`);
    }
    const sansTemoin = touchent.filter((name) => !/\bawait avecTemoinP6\(ctx, /.test(scenarioSource(name)));
    assert.deepEqual(sansTemoin.sort(), [...EXEMPTES_DU_TEMOIN], "scénarios it2 qui agissent sur opencode hors du témoin P6");
    // Les exemptés ne sont pas pour autant sans contrôle : ils posent le journal des requêtes du faux.
    assert.deepEqual(
      EXEMPTES_DU_TEMOIN.filter((name) => !/\bawait exigerP6SurRequetes\(ctx, /.test(scenarioSource(name))),
      [],
      "exempté sans même le journal des requêtes du faux",
    );
  });

  it("e2e/README.md nomme les trois exemptés et dit qu'ils ne vérifient rien hors « --faux »", () => {
    const readme = aplati(E2E_README);
    assert.doesNotMatch(
      readme,
      /chaque scénario qui agit sur opencode le fait sous le témoin P6/,
      "e2e/README.md annonce encore le témoin pour TOUS les scénarios it2",
    );
    assert.deepEqual(
      EXEMPTES_DU_TEMOIN.filter((name) => !readme.includes(`\`${name}\``)),
      [],
      "exempté non nommé par e2e/README.md",
    );
    assert.match(readme, /ne vérifient donc rien de P6 ni de P4 en `--reel-hors-ligne`/);
    assert.match(readme, /`exigerP6SurRequetes`/);
  });

  it("le §11 du RECAPITULATIF porte les deux exemptés à reprendre comme un reste, pas comme un fait", () => {
    const reste = entree(RECAP, "- **Témoin P6 du banc");
    for (const name of EXEMPTES_DU_TEMOIN) assert.ok(reste.includes(`\`${name}\``), `${name} absent du reste du §11`);
    assert.match(reste, /\*\*reste à faire\*\*/);
    assert.match(reste, /`--reel-hors-ligne`/);
  });
});

// --- 3. Confirmation d'un choix automatique : la documentation dit ce que fait le code ---------------------------------------------

/** Le câblage du dépôt, sans minuterie de sondage : aucun plafond de durée n'est joué ici. */
const TOUS: ReadonlyArray<ModuleName | Cockpit11Module> = MODULE_ORDER.map((name) =>
  name === "capWatch" ? (capWatchModuleWith({ schedule: () => () => undefined }) as Cockpit11Module) : name,
);

const DOSSIER = "/workspace/proj";
const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };
const FIN = "Synthèse du faux opencode.";

const CLEAN_GIT_CONFIG = [
  "[core]",
  `${TAB}repositoryformatversion = 0`,
  `${TAB}filemode = true`,
  `${TAB}bare = false`,
  `[remote ${DQ}origin${DQ}]`,
  `${TAB}url = https://example.invalid/depot.git`,
  "",
].join(NL);

function workspace(t: TestContext): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-croisements-it2-v4-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const proj = path.join(root, "proj");
  for (const dir of ["src", ".git/objects", ".git/refs"]) fs.mkdirSync(path.join(proj, ...dir.split("/")), { recursive: true });
  const files: Record<string, string> = {
    "README.md": `# Projet${NL}`,
    "src/a.ts": `export {};${NL}`,
    ".git/HEAD": `ref: refs/heads/main${NL}`,
    ".git/config": CLEAN_GIT_CONFIG,
  };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(proj, ...name.split("/")), content);
  return root;
}

async function start(t: TestContext, options: CockpitHarnessOptions = {}): Promise<CockpitHarness> {
  return startCockpit(t, { modules: TOUS, ...options, env: { workspaceDir: workspace(t), ...(options.env ?? {}) } });
}

/** Conversation dont opencode a rapporté l'assistant : l'activation réelle lit les règles de cet assistant-là. */
async function withAgent(h: CockpitHarness, title: string, agent = "build"): Promise<FakeSession> {
  const created = await h.call("POST", `/api/oc/session?directory=${encodeURIComponent(DOSSIER)}`, { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  const session = created.json<FakeSession>();
  await until(() => h.sessions.get(session.id));
  h.fake.script(session.id, { tools: [], followUp: { text: FIN } });
  const sent = await h.call("POST", `/api/oc/session/${session.id}/prompt_async?directory=${encodeURIComponent(DOSSIER)}`, {
    headers: h.headers.mutating,
    body: { agent, model: MODEL, parts: [{ type: "text", text: "Travaille." }] },
  });
  assert.equal(sent.status, 204, sent.body);
  await within(h.fake.settled(session.id), "réponse du faux terminée");
  await until(() => h.sessions.get(session.id)?.agent === agent);
  return session;
}

const urlAutonomie = (rootId: string) => `/api/conversations/${rootId}/autonomie`;
const putChoix = (h: CockpitHarness, rootId: string, body: unknown, headers?: Record<string, string>) =>
  h.call("PUT", urlAutonomie(rootId), { headers: headers ?? h.headers.confirmed, body });

describe("croisements it2 V4 : confirmation d'un choix automatique, code et documentation (L10d, L12a, DOC2)", () => {
  it("« Modifications automatiques » : la confirmation est redemandée à CHAQUE relâchement, et rien n'en garde la trace", async (t) => {
    const h = await start(t);
    const root = await withAgent(h, "Confirmation de « Modifications automatiques »");

    // Première activation : le serveur exige la confirmation, puis l'applique.
    const premier = await putChoix(h, root.id, { choix: "modifications" }, h.headers.mutating);
    assert.equal(premier.status, 428, premier.body);
    assert.equal(premier.json<{ error: string }>().error, "confirmation-requise");
    const applique = await putChoix(h, root.id, { choix: "modifications" });
    assert.equal(applique.status, 200, applique.body);
    assert.equal(applique.json<ConversationAutonomyView>().choix, "modifications");

    // Resserrer est immédiat (aucun en-tête de confirmation) : c'est ce que dit le README.
    const resserre = await putChoix(h, root.id, { choix: "demander" }, h.headers.mutating);
    assert.equal(resserre.status, 200, resserre.body);
    assert.equal(resserre.json<ConversationAutonomyView>().choix, "demander");

    // SECONDE activation du même choix, dans la même conversation : le serveur redemande la confirmation. « La première fois »
    // serait donc une promesse que le code ne tient pas (§11, écart D-09).
    const second = await putChoix(h, root.id, { choix: "modifications" }, h.headers.mutating);
    assert.equal(second.status, 428, second.body);
    assert.equal(second.json<{ error: string }>().error, "confirmation-requise");

    // Et la ligne stockée n'a aucune colonne où une confirmation déjà donnée pourrait être retenue.
    const colonnes = (h.db.prepare("PRAGMA table_info(conversation_autonomy)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(colonnes.includes("choix"), colonnes.join(", "));
    assert.deepEqual(colonnes.filter((name) => /confirm/i.test(name)), [], "une colonne retient la confirmation : le README peut la citer");
  });

  it("README et RECAPITULATIF : les deux choix automatiques demandent une confirmation à chaque relâchement, jamais « la première fois »", () => {
    const puce = entree(README, "- **Confirmation avant de relâcher.**");
    assert.doesNotMatch(puce, /la première fois/, "README : « Modifications automatiques » annoncé confirmé une seule fois");
    assert.match(puce, /Resserrer le choix est immédiat\./);
    assert.match(puce, /chaque fois qu'on relâche le choix/);

    const ligne = entree(RECAP, "| **Confirmation** |");
    assert.doesNotMatch(ligne, /la première fois/, "RECAPITULATIF : même promesse que le code ne tient pas");
    assert.match(ligne, /à \*\*chaque\*\* relâchement/);
  });

  it("le §11 du RECAPITULATIF consigne l'écart avec le §4.11 comme un reste", () => {
    const errata = entree(RECAP, "- **Écart D-09");
    assert.match(errata, /§4\.11/);
    assert.match(errata, /guardAutomatic/);
    assert.match(errata, /\*\*reste à faire\*\*/);
  });
});
