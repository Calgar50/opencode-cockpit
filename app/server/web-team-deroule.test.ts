// « Prévu / Réel » des équipes, réglages d'équipe et avis Simple de délégation (1.1, itération 4, L38c ; plan it4 §6 fiche L38c,
// §2.6, §2.7 ; spécification §5.1 l.878-883, §5.5, §5.6, §3.6 l.276, §3.14 l.437 ; C §7.3, §9.14 ; D-eq-13, D-eq-16, D-eq-24 ;
// décision U1).
// Le modèle PUR (web/pages/chat/team/deroule-model.ts) porte toute la logique : prévu et réel de chaque ligne, tentatives, étapes
// non lancées, durées, coûts, barres (génération, attente de vous, pause « vérification ») et fenêtre de temps. Rien n'y est lu
// d'opencode (A4) : les Archives montrent le même déroulé que le direct, à partir des seules données du cockpit.
// L'interface n'étant pas exécutée par `npm test`, les composants et les feuilles de style sont relus (contrat statique) :
// TeamsBudgetSettings invisible en mode Simple et branché sur le PUT /api/settings existant, barre « vérification » avec son bloc
// forced-colors, avis de délégation à deux textes avec [Voir les équipes] seulement quand les équipes sont ouvertes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { avisDelegationSimple, avisSimple, TEXTES as DELEGATION } from "./shared/delegation-texts.ts";
import { montant, TEXTES } from "./shared/team-texts.ts";
import type { StepRunView, TeamPauseView, TeamRunView } from "./shared/team-types.ts";
import {
  buildTeamDeroule,
  buildTeamDeroules,
  coutCellule,
  debutPause,
  fenetreDe,
  ligneDeroule,
  lignePause,
  type TeamDerouleRow,
} from "../web/pages/chat/team/deroule-model.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(APP_DIR, rel), "utf8");
const blank = (text: string) => text.replace(/[^\n]/g, " ");
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);

const P = TEXTES.partout;
const MODEL = "web/pages/chat/team/deroule-model.ts";
const VUE = "web/pages/chat/team/TeamDeroule.tsx";
const CSS = "web/pages/chat/team/team-deroule.css";
const REGLAGES = "web/pages/settings/TeamsBudgetSettings.tsx";
const BUDGET = "web/pages/settings/BudgetTab.tsx";
const AVIS = "web/pages/chat/delegation/DelegationNotice.tsx";

// --- Doublures ------------------------------------------------------------------------------------------------------------------

function step(patch: Partial<StepRunView> = {}): StepRunView {
  return {
    stepId: "relire",
    blocIndex: 0,
    ordre: 1,
    tour: 1,
    tentative: 1,
    titre: "Relecture du script",
    assistant: "relire-script",
    assistantTitre: "Relecteur de script",
    ia: { model: "gpt-5-mini", label: "Rapide", variant: null, choisieParEquipe: false },
    state: "terminee",
    cause: null,
    sessionId: "ses_1",
    queuedAt: 1_000,
    startedAt: 2_000,
    endedAt: 6_000,
    cost: 0.04,
    tronquee: false,
    extrait: "Trois points à corriger.",
    droits: [],
    ...patch,
  };
}

function run(patch: Partial<TeamRunView> = {}): TeamRunView {
  return {
    id: "run-1",
    teamId: "relecture-script",
    titre: "Chaîne de relecture de script",
    rootId: "ses_root",
    directory: "/w/projet",
    state: "terminee",
    cause: null,
    modeUi: "avance",
    estimate: { typique: 0.1, maximum: 0.4 },
    plafond: 0.4,
    cost: 0.09,
    steps: [step()],
    pause: null,
    relancable: false,
    suite: null,
    resultatsAjoutes: false,
    requestMessageId: null,
    resultMessageId: null,
    createdAt: 1_000,
    startedAt: 2_000,
    endedAt: 10_000,
    ...patch,
  };
}

function pause(patch: Partial<TeamPauseView> = {}): TeamPauseView {
  return { kind: "verification", blocId: "bloc-1", message: "Vérifiez le résumé.", resultat: null, suite: { typique: 0.05, maximum: 0.2 }, changement: null, ...patch };
}

const NOW = 10_000;
const ligneDe = (modele: { lignes: TeamDerouleRow[] }, cle: string) => modele.lignes.find((l) => l.cle.startsWith(cle));

// --- Modèle pur : prévu et réel ---------------------------------------------------------------------------------------------

describe("Déroulé des équipes : prévu et réel (spécification §5.1 l.878-883, D-eq-24)", () => {
  it("une ligne par étape (dernière tentative), prévue, avec le MOT de son état et son icône", () => {
    const modele = buildTeamDeroule(run(), true, NOW);
    assert.equal(modele.lignes.length, 1);
    const [ligne] = modele.lignes;
    assert.equal(ligne?.prevu, true, "une étape du déroulé est toujours prévue");
    assert.equal(ligne?.reel, P.etatsEtape.terminee);
    assert.equal(ligne?.icone, "check");
    assert.equal(ligne?.titre, "Relecture du script");
    assert.match(ligne?.detail ?? "", /Relecture du script · Relecteur de script · /);
    assert.equal(modele.etatMot, P.etatsEquipe.terminee);
    assert.equal(modele.bilan, `Étapes terminées : 1 sur 1 · ${montant(0.09)} $`);
  });

  it("« tentative 2 » à partir de la deuxième tentative, et la dernière tentative seule est montrée", () => {
    const modele = buildTeamDeroule(
      run({ steps: [step({ tentative: 1, state: "echec", endedAt: 3_000 }), step({ tentative: 2, state: "terminee", startedAt: 4_000, endedAt: 6_000 })] }),
      true,
      NOW,
    );
    assert.equal(modele.lignes.length, 1, "une seule ligne : la dernière tentative");
    assert.equal(modele.lignes[0]?.tentative, "tentative 2");
    assert.equal(modele.lignes[0]?.reel, P.etatsEtape.terminee);
    assert.equal(buildTeamDeroule(run(), true, NOW).lignes[0]?.tentative, null, "aucune mention à la première tentative");
  });

  it("étape NON LANCÉE : prévue, réel « Non lancée », ni début, ni durée, ni barre (aucun temps inventé)", () => {
    const jamais = step({ stepId: "synthese", ordre: 2, state: "non-lancee", startedAt: null, endedAt: null, sessionId: null, cost: 0, extrait: null });
    const modele = buildTeamDeroule(run({ steps: [step(), jamais] }), true, NOW);
    const ligne = ligneDe(modele, "synthese");
    assert.equal(ligne?.prevu, true);
    assert.equal(ligne?.reel, P.etatsEtape["non-lancee"]);
    assert.equal(ligne?.icone, "minus");
    assert.equal(ligne?.start, null);
    assert.equal(ligne?.durationMs, null);
    assert.deepEqual(ligne?.bars, [], "une étape sans début enregistré n'a AUCUNE barre");
  });

  it("étape « prevue » (pas encore commencée) : aucune barre non plus", () => {
    const modele = buildTeamDeroule(run({ state: "en-cours", endedAt: null, steps: [step({ state: "prevue", startedAt: null, endedAt: null })] }), true, NOW);
    assert.deepEqual(modele.lignes[0]?.bars, []);
    assert.equal(modele.lignes[0]?.reel, P.etatsEtape.prevue);
  });

  it("durées et coûts : la durée d'une étape finie est celle qui a été enregistrée ; une étape en cours court jusqu'à `now`", () => {
    const fini = buildTeamDeroule(run(), true, NOW).lignes[0];
    assert.equal(fini?.durationMs, 4_000, "6 000 − 2 000");
    assert.equal(fini?.cost, 0.04);
    const encours = buildTeamDeroule(run({ state: "en-cours", endedAt: null, steps: [step({ state: "en-cours", endedAt: null })] }), true, 9_000).lignes[0];
    assert.equal(encours?.durationMs, 7_000, "9 000 − 2 000, avec le `now` passé par l'appelant (aucune horloge lue ici)");
  });

  it("le coût d'une cellule s'écrit par montant(), jamais par formatUsd() (report MX-EQ §4.2)", () => {
    assert.equal(coutCellule(0.6), "0,60 $");
    assert.equal(coutCellule(0), `${montant(0)} $`);
    assert.equal(coutCellule(0.001), "< 0,01 $");
  });

  it("plusieurs lancements : du plus ancien au plus récent", () => {
    const modeles = buildTeamDeroules([run({ id: "b", createdAt: 5_000 }), run({ id: "a", createdAt: 1_000 })], true, NOW);
    assert.deepEqual(
      modeles.map((m) => m.runId),
      ["a", "b"],
    );
    assert.deepEqual(buildTeamDeroules([], true, NOW), [], "aucune équipe : aucun déroulé");
  });

  it("détail de l'étape : « choisie par l'équipe » en Avancé seulement (§3.13 l.413, décision n° 3)", () => {
    const choisie = step({ ia: { model: "gpt-5", label: "Fin", variant: null, choisieParEquipe: true } });
    const fenetre = { from: 0, to: 10_000 };
    assert.match(ligneDeroule(choisie, fenetre, NOW, true).detail, /IA de l'étape : Fin \(choisie par l'équipe\)/);
    assert.match(ligneDeroule(choisie, fenetre, NOW, false).detail, /IA : Fin \(celle de l'assistant\)/);
  });

  it("IA encore inconnue : le séparateur de fin est retiré, jamais remplacé par un texte inventé", () => {
    const sansIa = step({ ia: { model: null, label: null, variant: null, choisieParEquipe: false } });
    const detail = ligneDeroule(sansIa, { from: 0, to: 10_000 }, NOW, true).detail;
    assert.equal(detail, "Relecture du script · Relecteur de script");
  });
});

// --- Modèle pur : barres ----------------------------------------------------------------------------------------------------

describe("Déroulé des équipes : barres (génération, attente de vous, pause « vérification »)", () => {
  it("une étape qui travaille porte une barre « génération » ; celle qui attend votre accord une barre « attente-vous »", () => {
    const travail = buildTeamDeroule(run({ state: "en-cours", endedAt: null, steps: [step({ state: "en-cours", endedAt: null })] }), true, NOW);
    assert.equal(travail.lignes[0]?.bars[0]?.kind, "generation");
    const accord = buildTeamDeroule(run({ state: "en-cours", endedAt: null, steps: [step({ state: "attente-accord", endedAt: null })] }), true, NOW);
    assert.equal(accord.lignes[0]?.bars[0]?.kind, "attente-vous", "l'attente de vous se lit « vous », jamais comme du travail");
  });

  it("pause pour vérifier : une ligne PRÉVUE, barre « verification »", () => {
    const modele = buildTeamDeroule(run({ state: "attente-verification", endedAt: null, pause: pause() }), true, NOW);
    const ligne = modele.lignes.at(-1);
    assert.equal(ligne?.kind, "pause");
    assert.equal(ligne?.prevu, true, "la pause pour vérifier est écrite dans le déroulé de l'équipe");
    assert.equal(ligne?.titre, P.pauses.verification.titre);
    assert.equal(ligne?.reel, P.etatsEquipe["attente-verification"]);
    assert.equal(ligne?.bars[0]?.kind, "verification");
  });

  it("pause NON prévue (budget, assistant modifié, redémarrage, situation changée) : prévu faux, barre « attente-vous »", () => {
    for (const kind of ["budget", "modification", "redemarrage-cockpit", "changement"] as const) {
      const modele = buildTeamDeroule(run({ state: "attente-budget", endedAt: null, pause: pause({ kind }) }), true, NOW);
      const ligne = modele.lignes.at(-1);
      assert.equal(ligne?.prevu, false, kind);
      assert.equal(ligne?.bars[0]?.kind, "attente-vous", kind);
    }
  });

  it("aucune ligne de pause quand l'équipe n'attend pas", () => {
    assert.equal(lignePause(run(), { from: 0, to: 10_000 }, NOW), null);
    assert.equal(buildTeamDeroule(run(), true, NOW).lignes.every((l) => l.kind === "etape"), true);
  });

  it("début d'une pause : la fin de la dernière étape finie ; à défaut, le début du lancement", () => {
    assert.equal(debutPause(run({ steps: [step({ endedAt: 6_000 }), step({ stepId: "s2", endedAt: 7_500 })] }), 2_000), 7_500);
    assert.equal(debutPause(run({ steps: [step({ endedAt: null })] }), 2_000), 2_000, "aucune étape finie : le début du lancement");
  });

  it("barres bornées à la fenêtre : jamais hors de 0 à 100 %, largeur minimale visible", () => {
    const fenetre = fenetreDe(run(), NOW);
    assert.deepEqual(fenetre, { from: 2_000, to: 10_000 });
    for (const modele of buildTeamDeroules([run({ steps: [step(), step({ stepId: "s2", startedAt: 6_000, endedAt: 10_000 })] })], true, NOW)) {
      for (const ligne of modele.lignes) {
        for (const bar of ligne.bars) {
          assert.ok(bar.left >= 0 && bar.left <= 100, `left ${bar.left}`);
          assert.ok(bar.width > 0 && bar.left + bar.width <= 100.001, `width ${bar.width}`);
          assert.ok(bar.durationMs > 0);
        }
      }
    }
  });

  it("fenêtre d'un lancement jamais commencé : le lancement n'a pas d'étendue nulle (aucune division par zéro)", () => {
    const fenetre = fenetreDe(run({ state: "preparation", startedAt: null, endedAt: null, steps: [] }), 1_000);
    assert.ok(fenetre.to > fenetre.from);
    assert.deepEqual(buildTeamDeroule(run({ state: "preparation", startedAt: null, endedAt: null, steps: [] }), true, 1_000).lignes, []);
  });
});

// --- Vue : aucune lecture d'opencode, mot avec la hachure ---------------------------------------------------------------------

describe("Déroulé des équipes : vue (panneau de contexte et Archives)", () => {
  const source = read(VUE);
  const code = withoutComments(source);

  it("les lancements viennent de useTeamRuns (base du cockpit) : aucune requête à opencode (A4)", () => {
    assert.match(code, /useTeamRuns\(rootId\)/);
    assert.doesNotMatch(code, /fetch\(|api-oc|\/session\//, "aucun appel direct, aucune route d'opencode");
  });

  it("les deux emplacements (panneau de contexte et Archives) sont servis par le même composant", () => {
    assert.match(code, /placement === "archives"/);
    assert.match(read("web/pages/chat/activity/Deroule.tsx"), /<TeamDeroule rootId=\{rootId\} placement=\{placement\} advanced=\{advanced\} \/>/);
  });

  it("[Tableau] : les mêmes valeurs dans un <table>, sans aucune couleur", () => {
    assert.match(code, /<table/);
    assert.match(code, /aria-pressed=\{table\}/);
    for (const colonne of ["Qui", "Prévu", "Réel", "Début", "Durée", "Coût"]) assert.ok(source.includes(colonne), colonne);
  });

  it("la hachure ne dit jamais l'état seule : le mot est écrit dans la barre et l'état en toutes lettres sur la ligne", () => {
    assert.match(code, /"attente-vous": "vous"/);
    assert.match(code, /verification: "vérification"/);
    assert.match(code, /\{row\.reel\}/, "le mot de l'état est écrit sur la ligne");
  });

  it("aucune région aria-live propre, aucune animation (web-animations.test.ts couvre pages/chat/team)", () => {
    assert.doesNotMatch(code, /aria-live/);
    assert.doesNotMatch(withoutComments(read(CSS)), /animation|transition|@keyframes/);
  });

  it("la barre « vérification » porte son bloc @media (forced-colors: active) : hachure, bordure, mot gardé", () => {
    const css = read(CSS);
    const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
    assert.ok(css.includes("@media (forced-colors: active)"), "bloc de contraste forcé présent");
    assert.match(forced, /\.deroule-bar--verification\s*\{[^}]*repeating-linear-gradient\([^)]*CanvasText/);
    assert.match(forced, /\.deroule-bar--verification\s*\{[^}]*box-shadow:[^;]*CanvasText/);
    assert.match(withoutComments(css), /\.deroule-bar--verification\s*\{[^}]*repeating-linear-gradient/, "hachure aussi hors contraste forcé");
  });

  it("les barres « vous » réutilisent les classes de deroule.css (it1), qui portent déjà leur bloc forced-colors", () => {
    assert.match(code, /import "\.\.\/activity\/deroule\.css"/);
    const it1 = read("web/pages/chat/activity/deroule.css");
    assert.ok(it1.includes(".deroule-bar--attente-vous"), "classe de l'it1 réutilisée telle quelle");
    assert.doesNotMatch(withoutComments(read(CSS)), /\.deroule-bar--attente-vous\s*\{/, "team-deroule.css ne redéfinit pas la barre de l'it1");
  });
});

// --- Réglages des équipes (Paramètres › Budget) --------------------------------------------------------------------------------

describe("Réglages des équipes : mode Avancé seulement, par le PUT /api/settings existant (§3.6 l.276)", () => {
  const source = read(REGLAGES);
  const code = withoutComments(source);

  it("invisible en mode Simple : BudgetTab ne rend le bloc qu'en Avancé", () => {
    assert.match(withoutComments(read(BUDGET)), /\{advanced \? <TeamsBudgetSettings \/> : null\}/);
  });

  it("les chemins écrits sont `teams.*`, hors SIMPLE_SETTINGS_PATHS : le serveur refuserait l'écriture en Simple", async () => {
    assert.match(code, /save\(\{ teams: draft \}/);
    const { SIMPLE_SETTINGS_PATHS } = await import("./shared/assistant-rules.ts");
    assert.ok(!SIMPLE_SETTINGS_PATHS.some((chemin) => chemin === "teams" || chemin.startsWith("teams.")), JSON.stringify(SIMPLE_SETTINGS_PATHS));
  });

  it("les trois réglages de la spécification, avec les textes de T4t", () => {
    const R = TEXTES.avance.reglages;
    assert.equal(R.plafondLibelle, "Plafond maximum d'un lancement");
    assert.equal(R.plafondSuffixe, "$ (vide : 5 % du budget)");
    assert.equal(R.simultanees, "Étapes en même temps");
    assert.equal(R.equipesActives, "Équipes en cours en même temps");
    for (const cle of ["plafondLibelle", "plafondSuffixe", "simultanees", "equipesActives", "titre"] as const) {
      assert.match(code, new RegExp(`R\\.${cle}\\b`), cle);
    }
  });

  it("plafond vide : `null` (5 % du budget calculé par le serveur), jamais un montant écrit par l'interface", () => {
    assert.match(code, /maxCapUsd: maxCapUsd === undefined \? null : maxCapUsd/);
    assert.doesNotMatch(code, /0\.05|5 \/ 100/, "aucun calcul des 5 % dans l'interface");
  });

  it("aucune route neuve, aucun schéma touché : ni settings.ts, ni un nouveau client", () => {
    assert.doesNotMatch(code, /fetch\(|api\.put\(|\/api\/settings/, "l'écriture passe par useSettingsSave (api.saveSettings)");
    assert.match(code, /useSettingsSave|SectionFooter/);
  });

  it("le composant reste typé par slots.ts (contrat T4w figé)", () => {
    assert.match(source, /import type \{ TeamsBudgetSettingsProps \} from "\.\.\/chat\/team\/slots\.ts";/);
    assert.match(code, /export function TeamsBudgetSettings\(_props: TeamsBudgetSettingsProps\)/);
  });
});

// --- Avis Simple de délégation (§3.14 l.437, décision U1) ----------------------------------------------------------------------

describe("Avis Simple de délégation : deux textes selon `ouvertesEnSimple` (U1, écart Q5 (b) consigné par DOC-EQ)", () => {
  it("équipes FERMÉES : le texte court d'avant, sans bouton ni mention des équipes (P3)", () => {
    const avis = avisDelegationSimple(false);
    assert.equal(avis.texte, "En mode Simple, l'IA ne délègue pas : elle continue seule.");
    assert.equal(avis.texte, avisSimple(), "exactement le texte que le refus envoie déjà à opencode");
    assert.equal(avis.bouton, null, "aucune invitation vers une fonction que le serveur refuserait");
    assert.doesNotMatch(avis.texte, /équipe|Voir les/i);
  });

  it("équipes OUVERTES : le texte complet de la spécification et [Voir les équipes]", () => {
    const avis = avisDelegationSimple(true);
    assert.equal(avis.texte, "En mode Simple, l'IA ne délègue pas : elle continue seule. Pour faire travailler plusieurs assistants, lancez une équipe.");
    assert.equal(avis.bouton?.libelle, "Voir les équipes");
    assert.equal(avis.bouton?.href, "#/assistants/equipes");
    assert.ok(avis.texte.startsWith(avisSimple()), "le texte complet commence par le texte court");
  });

  it("le texte du refus envoyé à opencode ne change PAS : avisSimple() reste le texte court", () => {
    assert.equal(avisSimple(), DELEGATION.simple.avis);
    assert.doesNotMatch(avisSimple(), /équipe/i);
  });

  it("la vue n'affiche le bouton qu'avec le texte complet, et annonce le texte réellement affiché", () => {
    const code = withoutComments(read(AVIS));
    assert.match(code, /avis\.bouton === null \? null :/, "bouton rendu seulement quand il existe");
    assert.match(code, /\{avis\.texte\}/);
    assert.match(code, /say\(avisRef\.current\)/, "annonce du texte affiché, jamais de l'autre");
    assert.match(code, /reponse\.ouvertesEnSimple === true/, "seule `ouvertesEnSimple` ouvre le texte complet (U1)");
    assert.doesNotMatch(code, /EQUIPES_SIMPLE_OUVERTES/, "la constante n'est pas lisible depuis le navigateur");
  });

  it("les changements de l'avis tiennent entre les balises « équipes (it4) »", () => {
    for (const fichier of [AVIS, "server/shared/delegation-texts.ts"]) {
      const source = read(fichier);
      const debuts = (source.match(/--- équipes \(it4\) : début ---/g) ?? []).length;
      const fins = (source.match(/--- équipes \(it4\) : fin ---/g) ?? []).length;
      assert.ok(debuts > 0 && debuts === fins, `${fichier} : ${debuts} début(s), ${fins} fin(s)`);
    }
  });
});
