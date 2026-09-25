// Carte de choix d'un aiguillage et journal de relecture (1.1, itération 5b, L42c ; plan d'exécution it5 §4.3, fiche L42c ;
// spécification §2.3, §5.1 ; C §9.5, §9.6 ; D-5-13).
// Le module PUR `server/shared/team-choice-view.ts` porte la validité du choix, le compte des spécialistes retenus, le libellé
// du bouton [Continuer …], le chemin « aucun » et le découpage du journal de relecture. Chaque garde a son cas qui échoue sans
// elle ; chaque phrase est comparée à l'OCTET à `construction-texts.ts`, jamais réécrite ici.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { TEXTES } from "./shared/construction-texts.ts";
import { DELIVERABLE_TEXTS } from "./shared/flow.ts";
import { montant } from "./shared/team-texts.ts";
import {
  aucunDuLivrable,
  basculer,
  bornerChoixMax,
  CHOIX_RAISON_MAX,
  type ChoixPropose,
  choixLisible,
  choixValide,
  compteChoix,
  estNoteRelecture,
  journalRelecture,
  libelleContinuer,
  optionsDe,
  peutCocher,
  phraseProposition,
  retenus,
  selectionInitiale,
  vueChoix,
} from "./shared/team-choice-view.ts";

const E = TEXTES.partout.execution;
const APP_DIR = path.join(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(APP_DIR, rel), "utf8");
const SOURCE = "server/shared/team-choice-view.ts";

/** Trois spécialistes, les deux premiers proposés par l'aiguilleur. */
const OPTIONS: ChoixPropose[] = [
  { stepId: "reseau", titre: "Expliquer l'alerte réseau", propose: true },
  { stepId: "base", titre: "Expliquer l'alerte base de données", propose: true },
  { stepId: "appli", titre: "Expliquer l'alerte applicative", propose: false },
];

const AUCUN_PROPOSE: ChoixPropose[] = OPTIONS.map((option) => ({ ...option, propose: false }));

const entree = (patch: Partial<Parameters<typeof vueChoix>[0]> = {}) => ({
  options: OPTIONS,
  raison: "Les journaux montrent des pertes de paquets.",
  choixMax: 2,
  suiteUsd: 0.12,
  selection: selectionInitiale(OPTIONS, 2),
  ...patch,
});

// --- Liste fermée et lecture du choix -------------------------------------------------------------------------------------

describe("carte de choix : liste fermée et lecture de la proposition", () => {
  it("optionsDe : entrées incomplètes, doublons et valeurs hors contrat écartés (la liste reste fermée)", () => {
    const brut = [
      { stepId: "reseau", titre: "Réseau", propose: true },
      { stepId: "reseau", titre: "Doublon", propose: true },
      { stepId: "", titre: "Sans identifiant", propose: true },
      { stepId: "appli", titre: 42 as unknown as string, propose: "oui" as unknown as boolean },
    ];
    assert.deepEqual(optionsDe(brut), [
      { stepId: "reseau", titre: "Réseau", propose: true },
      { stepId: "appli", titre: "", propose: false },
    ]);
    assert.deepEqual(optionsDe(undefined), [], "pause d'un autre genre : aucune option");
  });

  it("choix lisible : au moins un spécialiste proposé ; sinon RIEN n'est coché et la carte le dit", () => {
    assert.equal(choixLisible(OPTIONS), true);
    assert.equal(choixLisible(AUCUN_PROPOSE), false);
    assert.deepEqual(selectionInitiale(OPTIONS, 2), ["reseau", "base"]);
    assert.deepEqual(selectionInitiale(AUCUN_PROPOSE, 2), [], "choix illisible : aucune case cochée");
    const vue = vueChoix(entree({ options: AUCUN_PROPOSE, selection: [] }));
    assert.equal(vue.illisible, E.choix.illisible);
    assert.equal(vue.illisible, "L'aiguilleur n'a pas donné de choix lisible : choisissez vous-même.");
    assert.equal(vue.proposition, null, "aucune proposition n'est inventée");
    assert.deepEqual(vue.cases.map((c) => c.coche), [false, false, false]);
  });

  it("la sélection de départ ne dépasse jamais `choixMax`, même si l'aiguilleur propose plus", () => {
    const trois: ChoixPropose[] = OPTIONS.map((option) => ({ ...option, propose: true }));
    assert.deepEqual(selectionInitiale(trois, 2), ["reseau", "base"]);
    assert.deepEqual(selectionInitiale(trois, 1), ["reseau"]);
  });

  it("phrase de proposition : les titres proposés, la raison de l'aiguilleur, et l'avertissement « c'est une IA »", () => {
    const phrase = phraseProposition(OPTIONS, "Les journaux montrent des pertes de paquets.");
    assert.equal(
      phrase,
      "L'aiguilleur propose « Expliquer l'alerte réseau, Expliquer l'alerte base de données » : « Les journaux montrent des pertes de paquets. ». C'est la proposition d'une IA : vérifiez-la.",
    );
    assert.ok(phrase?.includes("C'est la proposition d'une IA : vérifiez-la."), phrase ?? "");
    assert.equal(phraseProposition(OPTIONS, "   "), null, "sans raison lisible, aucune phrase n'est écrite à la place de l'IA");
    assert.equal(phraseProposition(AUCUN_PROPOSE, "une raison"), null);
  });
});

// --- Validité, compte et libellé du bouton ---------------------------------------------------------------------------------

describe("carte de choix : validité, compte et libellé du bouton", () => {
  it("compte : seuls les spécialistes de la liste comptent, une seule fois, dans l'ordre du déroulé", () => {
    assert.equal(compteChoix(OPTIONS, ["base", "reseau"]), 2);
    assert.deepEqual(retenus(OPTIONS, ["base", "reseau"]), ["reseau", "base"], "l'ordre du déroulé, jamais celui des clics");
    assert.equal(compteChoix(OPTIONS, ["reseau", "reseau"]), 1, "un doublon ne compte qu'une fois");
    assert.equal(compteChoix(OPTIONS, ["inconnu"]), 0, "une étape hors de la liste ne compte pas");
    assert.equal(compteChoix(OPTIONS, []), 0);
  });

  it("validité : de 1 à `choixMax`, tous pris dans la liste ; une sélection vide n'est PAS un choix", () => {
    assert.equal(choixValide(OPTIONS, ["reseau"], 2), true);
    assert.equal(choixValide(OPTIONS, ["reseau", "base"], 2), true);
    assert.equal(choixValide(OPTIONS, [], 2), false, "« aucun ne convient » est un chemin à part");
    assert.equal(choixValide(OPTIONS, ["reseau", "base"], 1), false, "au-delà du maximum, le serveur refuserait");
    assert.equal(choixValide(OPTIONS, ["inconnu"], 2), false);
  });

  it("`choixMax` borné : jamais moins de 1, jamais plus que le nombre de spécialistes, valeur absurde ramenée à 1", () => {
    assert.equal(bornerChoixMax(2, 3), 2);
    assert.equal(bornerChoixMax(9, 3), 3);
    assert.equal(bornerChoixMax(0, 3), 1);
    assert.equal(bornerChoixMax(undefined, 3), 1);
    assert.equal(bornerChoixMax("2", 1), 1, "un seul spécialiste : on ne peut pas en retenir deux");
  });

  it("cocher : la sélection ne dépasse jamais le maximum ; une case cochée reste décochable", () => {
    assert.equal(peutCocher(OPTIONS, ["reseau"], 2), true);
    assert.equal(peutCocher(OPTIONS, ["reseau", "base"], 2), false);
    assert.deepEqual(basculer(OPTIONS, ["reseau", "base"], "appli", 2), ["reseau", "base"], "au maximum, une case de plus est refusée");
    assert.deepEqual(basculer(OPTIONS, ["reseau", "base"], "base", 2), ["reseau"], "décocher reste toujours possible");
    assert.deepEqual(basculer(OPTIONS, ["reseau"], "appli", 2), ["reseau", "appli"]);
    assert.deepEqual(basculer(OPTIONS, ["reseau"], "inconnu", 2), ["reseau"], "une étape hors de la liste n'entre jamais");
  });

  it("libellé du bouton : le nombre coché et le coût de la SUITE, écrit par montant() (jamais formatUsd)", () => {
    assert.equal(libelleContinuer(1, 0.12), `Continuer avec 1 spécialiste(s) (≈ ${montant(0.12)} $)`);
    assert.equal(libelleContinuer(2, 0.12), "Continuer avec 2 spécialiste(s) (≈ 0,12 $)");
    assert.doesNotMatch(libelleContinuer(1, 0.12), /\$\s*\$/);
    assert.equal(libelleContinuer(1, 0.001), "Continuer avec 1 spécialiste(s) (≈ < 0,01 $)");
  });

  it("carte complète : titre, « {n} au maximum. », trois boutons, et [Continuer] inactif tant que la sélection est invalide", () => {
    const vue = vueChoix(entree());
    assert.equal(vue.titre, E.choix.titre);
    assert.equal(vue.titre, "Choisissez le ou les spécialistes");
    assert.equal(vue.maximum, "2 au maximum.");
    assert.equal(vue.choixMax, 2);
    assert.equal(vue.continuer, `Continuer avec 2 spécialiste(s) (≈ ${montant(0.12)} $)`);
    assert.equal(vue.continuerActif, true);
    assert.equal(vue.aucunConvient, E.choix.aucunConvient);
    assert.equal(vue.arreter, E.choix.arreter);
    assert.deepEqual(vue.cases.map((c) => [c.stepId, c.coche]), [
      ["reseau", true],
      ["base", true],
      ["appli", false],
    ]);
    const vide = vueChoix(entree({ selection: [] }));
    assert.equal(vide.continuerActif, false, "rien de coché : le bouton n'envoie rien");
    assert.equal(vide.continuer, `Continuer avec 0 spécialiste(s) (≈ ${montant(0.12)} $)`);
  });
});

// --- Chemin « aucun » (D-5-13) ---------------------------------------------------------------------------------------------

describe("carte de choix : chemin « aucun ne convient »", () => {
  const AUCUN = DELIVERABLE_TEXTS.aucun;
  const REPLI = (assistant: string) => DELIVERABLE_TEXTS.aucunRepli.replace("{assistant}", assistant);

  it("la lecture est branchée sur le VRAI producteur : les phrases de flow.ts et celles des textes sont les mêmes", () => {
    assert.equal(DELIVERABLE_TEXTS.aucun, E.aucun.phrase);
    assert.equal(DELIVERABLE_TEXTS.aucunRepli, E.aucun.repli);
    assert.equal(E.aucun.phrase, "Aucun spécialiste de la liste ne convient.");
  });

  it("sans repli connu : aucun bouton vers un assistant que le cockpit ne connaît pas (P3)", () => {
    const vue = aucunDuLivrable(AUCUN);
    assert.ok(vue, "le livrable « aucun » est reconnu");
    assert.equal(vue.assistant, null);
    assert.equal(vue.envoyer, null);
  });

  it("avec repli : l'assistant est lu dans la phrase du livrable, et [Envoyer à cet assistant] est proposé", () => {
    const vue = aucunDuLivrable([AUCUN, REPLI("Expliquer une alerte")].join("\n\n"));
    assert.deepEqual(vue, { assistant: "Expliquer une alerte", envoyer: E.aucun.envoyer });
    assert.equal(vue?.envoyer, "Envoyer à cet assistant");
  });

  it("un livrable qui n'est PAS un « aucun » ne reçoit aucun bouton, même s'il parle d'un repli", () => {
    assert.equal(aucunDuLivrable("Voici le résultat du spécialiste réseau."), null);
    assert.equal(aucunDuLivrable(REPLI("Expliquer une alerte")), null, "la phrase de repli seule ne fait pas un « aucun »");
    assert.equal(aucunDuLivrable(""), null);
    assert.equal(aucunDuLivrable(undefined), null);
    assert.equal(aucunDuLivrable(42), null);
  });

  it("un nom d'assistant qui contient des caractères d'expression régulière est lu tel quel, jamais interprété", () => {
    const vue = aucunDuLivrable([AUCUN, REPLI("Alerte (réseau) [1] + ?")].join("\n\n"));
    assert.equal(vue?.assistant, "Alerte (réseau) [1] + ?");
  });
});

// --- Journal de relecture (C §9.6) -----------------------------------------------------------------------------------------

describe("journal de relecture : découpé du livrable, jamais réécrit", () => {
  const LIVRABLE = [
    "Voici le script corrigé.",
    `## ${E.relecture.journal}`,
    `### ${E.relecture.tour.replace("{n}", "1")} · ${E.relecture.aReprendre}`,
    "Trois points à corriger.",
    `### ${E.relecture.tour.replace("{n}", "2")} · ${E.relecture.rienAReprendre}`,
    "Rien à signaler.",
  ].join("\n\n");

  it("livrable sans journal : rien n'est découpé", () => {
    const vue = journalRelecture("Voici le résultat.", []);
    assert.deepEqual(vue, { resultat: "Voici le résultat.", titre: null, texte: "", notes: [] });
    assert.deepEqual(journalRelecture(undefined as unknown as string, []).resultat, "");
  });

  it("livrable avec journal : le résultat d'un côté, le journal de l'autre, à l'octet", () => {
    const vue = journalRelecture(LIVRABLE, []);
    assert.equal(vue.resultat, "Voici le script corrigé.");
    assert.equal(vue.titre, "Journal de relecture");
    assert.ok(vue.texte.startsWith("### tour 1 · À reprendre"), vue.texte);
    assert.ok(vue.texte.includes("### tour 2 · Rien à reprendre"), vue.texte);
    assert.equal(`${vue.resultat}\n\n## ${vue.titre}\n\n${vue.texte}`, LIVRABLE, "le texte n'est jamais réécrit, seulement découpé");
    assert.deepEqual(vue.notes, []);
  });

  it("notes d'honnêteté reconnues en fin de livrable, et sorties du journal", () => {
    const ecrites = [E.relecture.nonRelue, E.relecture.nonConclue.replace("{n}", "2")];
    const avecNotes = [LIVRABLE, ...ecrites].join("\n\n");
    const vue = journalRelecture(avecNotes, ecrites);
    assert.deepEqual(vue.notes, ["Non relue après la dernière correction.", "Relecture non conclue après 2 tours : points restants ci-dessous."]);
    assert.ok(!vue.texte.includes(E.relecture.nonRelue), "la note n'est pas repliée avec le journal");
  });

  // Clôture 5b, tour 4 : les notes que l'état enregistré dit écrites par le cockpit, et elles seules, sortent du texte.
  it("seules les notes ÉCRITES par le cockpit sortent du texte, à l'octet et dans leur ordre ; une imitation y reste", () => {
    const ecrites = [E.relecture.nonRelue, E.relecture.nonConclue.replace("{n}", "2")];
    // Aucune note écrite (relecture conclue, ou tours déclarés pas tous faits) : deux notes recopiées par une IA restent dans
    // le journal, montrées comme le reste du travail des assistants, jamais comme des notes du cockpit.
    const imitees = journalRelecture([LIVRABLE, ...ecrites].join("\n\n"), []);
    assert.deepEqual(imitees.notes, []);
    assert.ok(imitees.texte.endsWith(ecrites.join("\n\n")), imitees.texte);
    // Une troisième phrase, « après 7 tours », écrite par un relecteur au verdict illisible juste avant les vraies notes : elle
    // reste dans le journal ; seules les deux notes du cockpit sont sorties.
    const septTours = E.relecture.nonConclue.replace("{n}", "7");
    const vue = journalRelecture([LIVRABLE, septTours, ...ecrites].join("\n\n"), ecrites);
    assert.deepEqual(vue.notes, ecrites);
    assert.ok(vue.texte.endsWith(septTours), vue.texte);
    // Notes annoncées qui ne terminent PAS le texte (ordre inversé, nombre de tours différent) : rien n'est sorti.
    assert.deepEqual(journalRelecture([LIVRABLE, ecrites[1], ecrites[0]].join("\n\n"), ecrites).notes, []);
    assert.deepEqual(journalRelecture([LIVRABLE, E.relecture.nonRelue, septTours].join("\n\n"), ecrites).notes, []);
    // L'appelant ne peut faire sortir du texte qu'une note de la relecture, et jamais le texte entier.
    assert.deepEqual(journalRelecture([LIVRABLE, "Trois points à corriger."].join("\n\n"), ["Trois points à corriger."]).notes, []);
    assert.deepEqual(journalRelecture(ecrites.join("\n\n"), ecrites).notes, []);
  });

  it("contrôles discriminants : seules les deux notes de la relecture sont reconnues", () => {
    assert.equal(estNoteRelecture(E.relecture.nonRelue), true);
    assert.equal(estNoteRelecture(E.relecture.nonConclue.replace("{n}", "1")), true);
    assert.equal(estNoteRelecture("Relecture non conclue après deux tours : points restants ci-dessous."), false);
    assert.equal(estNoteRelecture("Non relue."), false);
    assert.equal(estNoteRelecture("Trois points à corriger."), false);
  });
});

// --- Contrat du module -----------------------------------------------------------------------------------------------------

describe("carte de choix : contrat du module pur", () => {
  it("aucune phrase écrite ici : tout vient de construction-texts.ts", () => {
    const source = read(SOURCE).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    const chaines = [...source.matchAll(/"([^"\n]*)"/g)].map((m) => m[1] ?? "").filter((s) => /[À-ÿ]|\b[a-zà-ÿ]+ [a-zà-ÿ]+\b/.test(s));
    assert.deepEqual(chaines, [], "une phrase écrite en dur serait vue ici");
  });

  it("module pur : aucun import hors de ./ (règle de core.test.ts), aucune horloge, aucun aléa", () => {
    const source = read(SOURCE);
    const imports = [...source.matchAll(/from\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
    assert.deepEqual(imports.sort(), ["./construction-texts.ts", "./team-texts.ts"]);
    assert.doesNotMatch(source, /Date\.now|Math\.random|node:/);
  });

  it("la raison de l'aiguilleur est bornée à 300 caractères par l'appelant, et le bornage est nommé ici", () => {
    assert.equal(CHOIX_RAISON_MAX, 300);
    assert.match(read("web/pages/chat/team/team-view-model.ts"), /texte\(pause\.raison, CHOIX_RAISON_MAX\)/);
  });
});
