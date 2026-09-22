// Schéma modifiable d'une équipe (itération 5b, plan d'exécution it5 fiche L43 ; spécification §5.3 l.903, §5.5, §5.6 l.928,
// §6 ; conception C §8.2, §9.12, §11 S4, D10 ; D-5-20 : opérations pures d'abord, interface ensuite).
//
// Ce que ces tests tiennent :
// - chaque OPÉRATION du §6 : insertAfter, moveUp, moveDown, moveTo, moveToPlace, removeBloc, addAvis, removeAvis,
//   addSpecialiste, removeSpecialiste, transform, setRecoit, setTours, setChoixMax — chacune rend un NOUVEAU déroulé, revalidé
//   par validateFlow, et laisse le déroulé reçu intact ; une étape retirée n'abandonne jamais un lien qui la visait ;
// - chaque REFUS de C §8.2 avec son code et sa phrase du §4.3, à l'octet ;
// - la PROPRIÉTÉ : aucune suite d'opérations n'aboutit à un déroulé que le serveur refuserait sans qu'un problème soit AFFICHÉ
//   (200 suites tirées au hasard, graine fixe) ;
// - le MODÈLE de la vue : menus, cases des étapes plus haut, problèmes sur le bloc ou l'étape fautifs, JSON en lecture seule ;
// - l'INTERFACE, relue en statique (elle n'est pas exécutée par `npm test`) : chaque glisser a son bouton ou son menu
//   (WCAG 2.5.7), glisser aux événements `pointer` SANS bibliothèque (P8), refus écrit près de la cible et annoncé poliment,
//   [Voir le JSON] en lecture seule, même historique d'annulation que l'éditeur, aucun texte écrit dans le .tsx ;
// - la FEUILLE : bloc @media (forced-colors: active) non vide (test de T4w), aucune animation infinie.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { Rule, UiMode } from "./shared/assistant-rules.ts";
import { TEXTES as CONSTRUCTION_TEXTES } from "./shared/construction-texts.ts";
import { type FlowValidationContext, validateFlow } from "./shared/flow.ts";
import { brouillonDe, brouillonDeForme } from "./shared/flow-edit.ts";
import {
  addAvis,
  addSpecialiste,
  dropCheck,
  fusionnerProblemes,
  insertAfter,
  moveDown,
  moveTo,
  moveToPlace,
  moveUp,
  phraseRefus,
  PROBLEMES_DES_ASSISTANTS,
  problemesStructurels,
  removeAvis,
  removeBloc,
  removeSpecialiste,
  SCHEMA_FORMES,
  SCHEMA_REFUS_CODES,
  type SchemaContext,
  type SchemaOpResult,
  schemaModel,
  setChoixMax,
  setRecoit,
  setTours,
  transform,
} from "./shared/flow-schema-ops.ts";
import { FLOW_LIMITS, FLOW_VERSION, stepInputEtapes } from "./shared/team-limits.ts";
import { TEXTES as TEAM_TEXTES } from "./shared/team-texts.ts";
import type { Flow, FlowBlock, FlowProblem, FlowStep, StepAssistant } from "./shared/team-types.ts";

// --- Montages -------------------------------------------------------------------------------------------------------------------

const REGLES_LECTURE: Rule[] = [
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "edit", pattern: "*", action: "deny" },
  { permission: "bash", pattern: "*", action: "deny" },
  { permission: "task", pattern: "*", action: "deny" },
  { permission: "webfetch", pattern: "*", action: "deny" },
  { permission: "websearch", pattern: "*", action: "deny" },
  { permission: "external_directory", pattern: "*", action: "deny" },
];

function assistant(name: string, model: string | null = "github-copilot/gpt-5-mini"): StepAssistant {
  return {
    name,
    title: `Titre de ${name}`,
    origin: "catalogue",
    rights: "lecture",
    mode: "primary",
    hidden: false,
    rules: REGLES_LECTURE,
    model,
    available: true,
    steps: 12,
    taille: "M",
  };
}

const REDACTEUR = assistant("rediger-note");
const RELECTEUR = assistant("relecteur-critique", "github-copilot/claude-sonnet-5");
const ASSISTANTS = [REDACTEUR, RELECTEUR];

const validation = (mode: UiMode = "avance", over: Partial<FlowValidationContext> = {}): FlowValidationContext => ({
  assistants: ASSISTANTS,
  mode,
  niveauDisponible: () => true,
  ...over,
});

const contexte = (over: Partial<SchemaContext> = {}): SchemaContext => ({ validation: validation(), ...over });

const step = (id: string, over: Partial<FlowStep> = {}): FlowStep => ({
  id,
  titre: `Étape ${id}`,
  assistant: REDACTEUR.name,
  niveau: null,
  taille: "S",
  consigne: `Consigne de ${id}`,
  recoit: "demande",
  ...over,
});

const flowOf = (...blocs: FlowBlock[]): Flow => ({ version: FLOW_VERSION, blocs });

const etapeBloc = (id: string, over: Partial<FlowStep> = {}): FlowBlock => ({ type: "etape", id: `b-${id}`, etape: step(id, over) });

/** Deux étapes à la suite : le déroulé le plus simple qui laisse un lien possible (la seconde reçoit ce qu'on lui donne). */
const DEUX_ETAPES = (): Flow => flowOf(etapeBloc("un"), etapeBloc("deux", { recoit: "precedent" }));

const avisBloc = (): FlowBlock => ({
  type: "avis",
  id: "b-avis",
  avis: [step("avis1", { titre: "Premier avis" }), step("avis2", { titre: "Second avis" })],
  synthese: step("synthese", { titre: "Synthèse", recoit: "tous" }),
});

const relectureBloc = (over: Partial<Extract<FlowBlock, { type: "relecture" }>> = {}): FlowBlock => ({
  type: "relecture",
  id: "b-relecture",
  auteur: step("auteur", { titre: "Rédaction" }),
  relecteur: step("relecteur", { titre: "Relecture", assistant: RELECTEUR.name, recoit: "precedent" }),
  toursMax: 1,
  pauseAvantRelecture: false,
  ...over,
});

const aiguillageBloc = (over: Partial<Extract<FlowBlock, { type: "aiguillage" }>> = {}): FlowBlock => ({
  type: "aiguillage",
  id: "b-aiguillage",
  aiguilleur: step("aiguilleur", { titre: "Aiguillage" }),
  specialistes: [step("sql", { titre: "Requête SQL" }), step("script", { titre: "Script" })],
  choixMax: 1,
  synthese: null,
  ...over,
});

/** Identifiants des blocs, dans l'ordre : ce que les déplacements changent. */
const blocIds = (flow: Flow): string[] => flow.blocs.map((block) => block.id);

/** Étapes déclarées d'un bloc, dans l'ordre d'écriture. */
function etapesDe(block: FlowBlock): FlowStep[] {
  if (block.type === "etape") return [block.etape];
  if (block.type === "avis") return [...block.avis, block.synthese];
  if (block.type === "relecture") return [block.auteur, block.relecteur];
  if (block.type === "aiguillage") return [block.aiguilleur, ...block.specialistes, ...(block.synthese ? [block.synthese] : [])];
  return [];
}

const toutesLesEtapes = (flow: Flow): FlowStep[] => flow.blocs.flatMap(etapesDe);

/** Problèmes de LIEN qui bloquent, réduits à leur code et à leur étape : ce qu'un lien pendant laisse derrière lui. */
const liensBloquants = (problemes: readonly FlowProblem[]): string[] =>
  problemes.filter((probleme) => probleme.bloquant && probleme.code.startsWith("lien-")).map((probleme) => `${probleme.code}|${probleme.etape ?? ""}`);

/** Chaque opération revalide : ce qu'elle rend est EXACTEMENT ce que le serveur dira du déroulé rendu (C §11 S4). */
function revalide(resultat: SchemaOpResult, ctx: SchemaContext = contexte()): void {
  assert.deepEqual(resultat.problemes, validateFlow(resultat.flow, ctx.validation));
}

// --- Opérations -------------------------------------------------------------------------------------------------------------

describe("schéma modifiable : opérations pures (C §8.2)", () => {
  it("insertAfter : un bloc neuf de chaque forme, juste après le bloc visé, sans toucher le déroulé reçu", () => {
    const flow = DEUX_ETAPES();
    const avant = structuredClone(flow);
    for (const forme of ["etape", "avis", "relecture", "pause"] as const) {
      const resultat = insertAfter(flow, "b-un", forme, contexte());
      assert.equal(resultat.change, true, forme);
      assert.equal(resultat.flow.blocs.length, 3, forme);
      assert.equal(resultat.flow.blocs[1]?.type, forme, forme);
      assert.equal(resultat.flow.blocs[0]?.id, "b-un", forme);
      assert.notEqual(resultat.flow, flow, forme);
      revalide(resultat);
    }
    assert.deepEqual(flow, avant, "le déroulé reçu n'est jamais modifié");
  });

  it("insertAfter : un aiguillage ne s'insère jamais après un bloc (il ne peut être que le premier)", () => {
    const resultat = insertAfter(DEUX_ETAPES(), "b-un", "aiguillage", contexte());
    assert.equal(resultat.change, false);
    assert.equal(resultat.flow.blocs.length, 2);
  });

  it("insertAfter : bloc inconnu, ou borne des blocs de travail atteinte → déroulé rendu tel quel", () => {
    const flow = DEUX_ETAPES();
    assert.equal(insertAfter(flow, "b-inconnu", "etape", contexte()).change, false);
    let plein = flow;
    for (let i = 0; i < FLOW_LIMITS.blocsTravail - 2; i++) {
      const pas = insertAfter(plein, "b-un", "etape", contexte());
      assert.equal(pas.change, true);
      plein = pas.flow;
    }
    assert.equal(plein.blocs.length, FLOW_LIMITS.blocsTravail);
    const trop = insertAfter(plein, "b-un", "etape", contexte());
    assert.equal(trop.change, false);
    assert.equal(trop.flow, plein, "rien n'a bougé : le déroulé reçu est rendu tel quel");
  });

  it("moveUp et moveDown : un rang à la fois ; aux extrémités, rien ne bouge", () => {
    const flow = flowOf(etapeBloc("un"), etapeBloc("deux", { recoit: "precedent" }), etapeBloc("trois", { recoit: "precedent" }));
    const monte = moveUp(flow, "b-trois", contexte());
    assert.deepEqual(blocIds(monte.flow), ["b-un", "b-trois", "b-deux"]);
    revalide(monte);
    const descend = moveDown(flow, "b-un", contexte());
    assert.deepEqual(blocIds(descend.flow), ["b-deux", "b-un", "b-trois"]);
    assert.equal(moveUp(flow, "b-un", contexte()).change, false);
    assert.equal(moveDown(flow, "b-trois", contexte()).change, false);
    assert.equal(moveUp(flow, "b-inconnu", contexte()).change, false);
  });

  it("moveTo : la place visée, atteinte par répétition de moveUp / moveDown (un seul état d'historique)", () => {
    const flow = flowOf(etapeBloc("un"), etapeBloc("deux", { recoit: "precedent" }), etapeBloc("trois", { recoit: "precedent" }));
    const versLaFin = moveTo(flow, "b-un", 2, contexte());
    assert.deepEqual(blocIds(versLaFin.flow), ["b-deux", "b-trois", "b-un"]);
    revalide(versLaFin);
    const versLeHaut = moveTo(flow, "b-trois", 0, contexte());
    assert.deepEqual(blocIds(versLeHaut.flow), ["b-trois", "b-un", "b-deux"]);
    assert.equal(moveTo(flow, "b-deux", 1, contexte()).change, false, "déjà à sa place");
    assert.equal(moveTo(flow, "b-inconnu", 0, contexte()).change, false);
    // Place hors de la liste : bornée à la liste, jamais une erreur.
    assert.deepEqual(blocIds(moveTo(flow, "b-un", 99, contexte()).flow), ["b-deux", "b-trois", "b-un"]);
  });

  it("moveToPlace : la PLACE dessinée par la vue (l'interstice AVANT un bloc), jamais un rang", () => {
    // Quatre blocs, quatre rangs 0 1 2 3 ; cinq places 0 1 2 3 4, chacune dans l'interstice qui PRÉCÈDE le bloc de ce rang,
    // la cinquième après le dernier bloc (SchemaEditor.tsx : `place(ligne.index)` puis `place(ligne.index + 1)`).
    const quatre = flowOf(
      etapeBloc("1"),
      etapeBloc("3", { recoit: "precedent" }),
      etapeBloc("5", { recoit: "precedent" }),
      etapeBloc("7", { recoit: "precedent" }),
    );
    // Les deux interstices qui bordent le bloc ne demandent rien : les reposer là n'est pas un geste.
    assert.equal(moveToPlace(quatre, "b-1", 0, contexte()).change, false, "place 0 : juste au-dessus de b-1");
    assert.equal(moveToPlace(quatre, "b-1", 1, contexte()).change, false, "place 1 : juste au-dessous de b-1");
    assert.equal(moveToPlace(quatre, "b-5", 2, contexte()).change, false, "place 2 : juste au-dessus de b-5");
    assert.equal(moveToPlace(quatre, "b-5", 3, contexte()).change, false, "place 3 : juste au-dessous de b-5");
    // Vers le BAS : le bloc atterrit dans l'interstice montré, pas un cran plus bas.
    const place2 = moveToPlace(quatre, "b-1", 2, contexte());
    assert.deepEqual(blocIds(place2.flow), ["b-3", "b-1", "b-5", "b-7"], "place 2 : entre b-3 et b-5");
    revalide(place2);
    assert.deepEqual(blocIds(moveToPlace(quatre, "b-1", 3, contexte()).flow), ["b-3", "b-5", "b-1", "b-7"], "place 3 : entre b-5 et b-7");
    assert.deepEqual(blocIds(moveToPlace(quatre, "b-1", 4, contexte()).flow), ["b-3", "b-5", "b-7", "b-1"], "dernière place : à la fin");
    // Vers le HAUT, la place et le rang coïncident déjà : rien ne change de ce côté.
    assert.deepEqual(blocIds(moveToPlace(quatre, "b-7", 1, contexte()).flow), ["b-1", "b-7", "b-3", "b-5"]);
    assert.deepEqual(blocIds(moveToPlace(quatre, "b-7", 0, contexte()).flow), ["b-7", "b-1", "b-3", "b-5"]);
    assert.equal(moveToPlace(quatre, "b-inconnu", 0, contexte()).change, false);
    // `moveTo`, lui, garde sa sémantique de RANG : c'est la conversion qui manquait, pas l'opération.
    assert.deepEqual(blocIds(moveTo(quatre, "b-1", 2, contexte()).flow), ["b-3", "b-5", "b-1", "b-7"]);
  });

  it("liens pendants : une étape retirée n'abandonne jamais un `recoit: {etapes}` qui la vise encore", () => {
    // Déroulé du constat : « Rapport » reçoit le résultat de « Collecte », exactement ce que le port de sortie et le menu
    // « Reçoit le résultat de… » laissent poser en Avancé.
    const trois = flowOf(
      etapeBloc("1", { titre: "Collecte" }),
      etapeBloc("2", { titre: "Analyse", recoit: "precedent" }),
      etapeBloc("3", { titre: "Rapport", recoit: { etapes: ["1"] } }),
    );
    assert.deepEqual(liensBloquants(validateFlow(trois, contexte().validation)), [], "le déroulé de départ est recevable");
    for (const [nom, res] of [
      ["transform", transform(trois, "b-1", "relecture", contexte())],
      ["removeBloc", removeBloc(trois, "b-1", contexte())],
    ] as const) {
      assert.equal(res.change, true, nom);
      assert.equal(res.refus, null, nom);
      // Ni `lien-arriere` ni aucun autre `lien-*` : l'utilisateur n'a pas fait de lien vers le bas, il a retiré une étape.
      assert.deepEqual(liensBloquants(res.problemes), [], `${nom} : lien resté pendant`);
      // Le lien est OUBLIÉ, et l'étape retombe sur la valeur par défaut de sa place.
      const rapport = toutesLesEtapes(res.flow).find((etape) => etape.titre === "Rapport");
      assert.equal(stepInputEtapes(rapport?.recoit), null, `${nom} : lien vers une étape disparue`);
      // Le menu de l'étape ne propose donc plus rien à décocher qui n'existe pas.
      const ligne = schemaModel(res.flow, res.problemes, contexte()).lignes.at(-1);
      const existantes = new Set(toutesLesEtapes(res.flow).map((etape) => etape.id));
      for (const id of ligne?.recoitDe ?? []) assert.ok(existantes.has(id), `${nom} : ${id} n'existe plus`);
    }
    // [Retirer cet avis] fait disparaître une étape de la même façon : le lien qui la visait est oublié aussi.
    const troisAvis = addAvis(flowOf(avisBloc(), etapeBloc("suite", { recoit: { etapes: ["avis1"] } })), "b-avis", contexte());
    assert.equal(troisAvis.change, true);
    const retire = removeAvis(troisAvis.flow, "b-avis", "avis1", contexte());
    assert.equal(retire.change, true);
    assert.deepEqual(liensBloquants(retire.problemes), [], "removeAvis : lien resté pendant");
    // Une liste dont TOUTES les étapes existent encore n'est jamais détruite en silence (contrôle discriminant).
    const garde = moveUp(trois, "b-3", contexte());
    assert.equal(garde.change, true);
    assert.deepEqual(stepInputEtapes(toutesLesEtapes(garde.flow).find((etape) => etape.titre === "Rapport")?.recoit), ["1"]);
  });

  it("removeBloc : le bloc et ses étapes quittent le déroulé ; un identifiant inconnu ne change rien", () => {
    const flow = flowOf(etapeBloc("un"), avisBloc());
    const resultat = removeBloc(flow, "b-avis", contexte());
    assert.deepEqual(blocIds(resultat.flow), ["b-un"]);
    revalide(resultat);
    assert.equal(removeBloc(flow, "b-inconnu", contexte()).change, false);
  });

  it("addAvis et removeAvis : de 2 à 5 avis, bornes comprises", () => {
    let flow = flowOf(avisBloc());
    for (let n = FLOW_LIMITS.avisMin; n < FLOW_LIMITS.avisMax; n++) {
      const resultat = addAvis(flow, "b-avis", contexte());
      assert.equal(resultat.change, true, `avis ${n}`);
      revalide(resultat);
      flow = resultat.flow;
    }
    const bloc = flow.blocs[0];
    assert.equal(bloc?.type === "avis" ? bloc.avis.length : 0, FLOW_LIMITS.avisMax);
    assert.equal(addAvis(flow, "b-avis", contexte()).change, false, "borne haute");
    const retire = removeAvis(flow, "b-avis", "avis1", contexte());
    assert.equal(retire.change, true);
    revalide(retire);
    const deux = flowOf(avisBloc());
    assert.equal(removeAvis(deux, "b-avis", "avis1", contexte()).change, false, "borne basse : 2 avis");
    assert.equal(addAvis(deux, "b-inconnu", contexte()).change, false);
  });

  it("addSpecialiste et removeSpecialiste : de 2 à 8 spécialistes, dans la limite des 12 étapes", () => {
    let flow = flowOf(aiguillageBloc());
    for (let n = FLOW_LIMITS.specialistesMin; n < FLOW_LIMITS.etapes; n++) {
      const resultat = addSpecialiste(flow, "b-aiguillage", contexte());
      if (!resultat.change) break;
      revalide(resultat);
      flow = resultat.flow;
    }
    const bloc = flow.blocs[0];
    assert.equal(bloc?.type === "aiguillage" ? bloc.specialistes.length : 0, FLOW_LIMITS.specialistesMax, "borne des spécialistes");
    assert.equal(addSpecialiste(flow, "b-aiguillage", contexte()).change, false, "borne haute");
    // La borne des 12 étapes vient avant celle des spécialistes dès qu'un autre bloc occupe la place.
    const charge = insertAfter(flow, "b-aiguillage", "avis", contexte());
    assert.equal(charge.change, true);
    assert.equal(addSpecialiste(charge.flow, "b-aiguillage", contexte()).change, false, "borne des 12 étapes");
    const retire = removeSpecialiste(flow, "b-aiguillage", "sql", contexte());
    assert.equal(retire.change, true);
    revalide(retire);
    const deux = flowOf(aiguillageBloc());
    assert.equal(removeSpecialiste(deux, "b-aiguillage", "sql", contexte()).change, false, "borne basse : 2 spécialistes");
  });

  it("setTours : 1 ou 2 tours (FLOW_LIMITS.toursMax), jamais davantage", () => {
    const flow = flowOf(relectureBloc());
    const deux = setTours(flow, "b-relecture", 2, contexte());
    assert.equal(deux.change, true);
    assert.equal(deux.flow.blocs[0]?.type === "relecture" ? deux.flow.blocs[0].toursMax : 0, 2);
    revalide(deux);
    assert.equal(setTours(deux.flow, "b-relecture", 2, contexte()).change, false, "valeur déjà posée");
    assert.equal(setTours(flowOf(avisBloc()), "b-avis", 2, contexte()).change, false, "autre forme");
  });

  it("setChoixMax : 1 ou 2 ; à 2, la synthèse est posée par l'éditeur guidé (grammaire `synthese-requise`)", () => {
    const flow = flowOf(aiguillageBloc());
    const deux = setChoixMax(flow, "b-aiguillage", 2, contexte());
    assert.equal(deux.change, true);
    const bloc = deux.flow.blocs[0];
    assert.equal(bloc?.type === "aiguillage" ? bloc.choixMax : 0, 2);
    assert.notEqual(bloc?.type === "aiguillage" ? bloc.synthese : null, null, "la synthèse est exigée à 2 choix");
    revalide(deux);
    assert.equal(setChoixMax(flowOf(relectureBloc()), "b-relecture", 2, contexte()).change, false, "autre forme");
  });

  it("transform : la forme change à la MÊME place et le travail des étapes est gardé (titre, assistant, consigne)", () => {
    const flow = flowOf(etapeBloc("un"), etapeBloc("deux", { recoit: "precedent" }));
    const resultat = transform(flow, "b-deux", "relecture", contexte());
    assert.equal(resultat.change, true);
    assert.equal(resultat.flow.blocs.length, 2);
    const bloc = resultat.flow.blocs[1];
    assert.equal(bloc?.type, "relecture");
    if (bloc?.type !== "relecture") return;
    assert.equal(bloc.auteur.titre, "Étape deux");
    assert.equal(bloc.auteur.consigne, "Consigne de deux");
    assert.equal(bloc.auteur.assistant, REDACTEUR.name);
    // L'entrée reste celle que la grammaire impose : le relecteur reçoit la version courante de l'auteur.
    assert.equal(bloc.relecteur.recoit, "precedent");
    revalide(resultat);
  });

  it("transform : les étapes en trop sont perdues, un titre vide ne remplace jamais le titre de rôle", () => {
    const resultat = transform(flowOf(avisBloc()), "b-avis", "etape", contexte());
    assert.equal(resultat.change, true);
    const bloc = resultat.flow.blocs[0];
    assert.equal(bloc?.type, "etape");
    assert.equal(bloc?.type === "etape" ? bloc.etape.titre : "", "Premier avis");
    // Vers une forme à synthèse : une étape sans titre laisse le titre de rôle en place.
    const sansTitre = flowOf({ type: "etape", id: "b-vide", etape: step("vide", { titre: "" }) });
    const versAvis = transform(sansTitre, "b-vide", "avis", contexte());
    assert.equal(versAvis.change, true);
    const avis = versAvis.flow.blocs[0];
    assert.equal(avis?.type === "avis" ? avis.avis[0]?.titre : "?", "");
    assert.equal(avis?.type === "avis" ? avis.synthese.titre : "?", TEAM_TEXTES.partout.editeur.synthese);
  });

  it("transform : même forme, bloc inconnu, ou forme qui ne tient pas à cette place → déroulé rendu tel quel", () => {
    const flow = flowOf(etapeBloc("un"), etapeBloc("deux", { recoit: "precedent" }));
    assert.equal(transform(flow, "b-un", "etape", contexte()).change, false, "même forme");
    assert.equal(transform(flow, "b-inconnu", "avis", contexte()).change, false, "bloc inconnu");
    assert.equal(transform(flow, "b-deux", "aiguillage", contexte()).change, false, "un aiguillage est le premier bloc");
    const premier = transform(flow, "b-un", "aiguillage", contexte());
    assert.equal(premier.change, true, "en tête, l'aiguillage est possible");
    revalide(premier);
  });

  it("setRecoit : écrit `recoit: {etapes}` vers une étape plus haut, et rend l'étape à sa valeur par défaut quand la liste est vide", () => {
    const flow = DEUX_ETAPES();
    const lie = setRecoit(flow, "deux", ["un"], contexte());
    assert.equal(lie.change, true);
    assert.equal(lie.refus, null);
    assert.deepEqual(stepInputEtapes(toutesLesEtapes(lie.flow)[1]?.recoit), ["un"]);
    revalide(lie);
    const delie = setRecoit(lie.flow, "deux", [], contexte());
    assert.equal(delie.change, true);
    assert.equal(toutesLesEtapes(delie.flow)[1]?.recoit, "precedent");
    assert.equal(setRecoit(flow, "inconnue", ["un"], contexte()).change, false);
  });

  it("setRecoit : un lien que le cockpit ne sait pas exécuter est REFUSÉ, jamais écrit puis signalé après coup", () => {
    const flow = DEUX_ETAPES();
    const versLeHaut = setRecoit(flow, "un", ["deux"], contexte());
    assert.equal(versLeHaut.change, false);
    assert.equal(versLeHaut.refus?.code, "versLeBas");
    assert.equal(versLeHaut.flow, flow);
    const soiMeme = setRecoit(flow, "deux", ["deux"], contexte());
    assert.equal(soiMeme.refus?.code, "retourArriere");
  });

  it("chaque opération rend un NOUVEAU déroulé : l'objet reçu n'est jamais modifié", () => {
    const flow = flowOf(etapeBloc("un"), avisBloc(), relectureBloc());
    const copie = structuredClone(flow);
    insertAfter(flow, "b-un", "etape", contexte());
    moveDown(flow, "b-un", contexte());
    addAvis(flow, "b-avis", contexte());
    transform(flow, "b-un", "relecture", contexte());
    setRecoit(flow, "auteur", ["un"], contexte());
    setTours(flow, "b-relecture", 2, contexte());
    removeBloc(flow, "b-avis", contexte());
    assert.deepEqual(flow, copie);
  });

  it("compteur d'identifiants : un identifiant déjà rendu n'est jamais réattribué après une suppression", () => {
    const depart = brouillonDeForme("a-la-suite");
    const sans = removeBloc(depart.flow, depart.flow.blocs[1]?.id ?? "", { ...contexte(), compteur: depart.compteur });
    assert.equal(sans.change, true);
    const ajout = insertAfter(sans.flow, sans.flow.blocs[0]?.id ?? "", "etape", { ...contexte(), compteur: sans.compteur });
    const neufs = new Set([...blocIds(ajout.flow), ...toutesLesEtapes(ajout.flow).map((etape) => etape.id)]);
    const retires = new Set([...blocIds(depart.flow), ...toutesLesEtapes(depart.flow).map((etape) => etape.id)]);
    const reattribues = [...neufs].filter((id) => retires.has(id) && !blocIds(sans.flow).includes(id) && !toutesLesEtapes(sans.flow).some((e) => e.id === id));
    assert.deepEqual(reattribues, [], "un identifiant retiré ne revient pas");
  });
});

// --- Refus (C §8.2, phrases du §4.3) ------------------------------------------------------------------------------------------

describe("schéma modifiable : refus (C §8.2)", () => {
  const FLOW = flowOf(etapeBloc("un"), avisBloc(), relectureBloc());

  it("« vers le bas » : un lien ne peut aller que vers une étape plus bas", () => {
    const verdict = dropCheck(FLOW, { genre: "lien", stepId: "auteur" }, { genre: "etape", stepId: "un" });
    assert.deepEqual(verdict, { ok: false, code: "versLeBas" });
    assert.equal(phraseRefus("versLeBas"), "Le cockpit exécute les étapes de haut en bas : un lien ne peut aller que vers une étape plus bas.");
  });

  it("« retour en arrière » : un lien vers une étape du même bloc, ou vers elle-même, est une boucle", () => {
    assert.deepEqual(dropCheck(FLOW, { genre: "lien", stepId: "avis1" }, { genre: "etape", stepId: "avis2" }), { ok: false, code: "retourArriere" });
    assert.deepEqual(dropCheck(FLOW, { genre: "lien", stepId: "un" }, { genre: "etape", stepId: "un" }), { ok: false, code: "retourArriere" });
    assert.equal(phraseRefus("retourArriere"), "Seule une relecture revient en arrière, 2 tours au maximum.");
  });

  it("« condition libre » : entrée imposée par la grammaire, pause, ou lien lâché hors d'une étape", () => {
    // Un avis, une synthèse, un relecteur : leur entrée est imposée, seuls le verdict et le choix changent la suite.
    for (const cible of ["avis1", "synthese", "relecteur"]) {
      assert.deepEqual(dropCheck(FLOW, { genre: "lien", stepId: "un" }, { genre: "etape", stepId: cible }), { ok: false, code: "condition" }, cible);
    }
    const avecPause = flowOf(etapeBloc("un"), { type: "pause", id: "b-pause", message: "" }, etapeBloc("deux", { recoit: "precedent" }));
    assert.deepEqual(dropCheck(avecPause, { genre: "lien", stepId: "un" }, { genre: "bloc", blocId: "b-pause" }), { ok: false, code: "condition" });
    assert.deepEqual(dropCheck(FLOW, { genre: "lien", stepId: "un" }, { genre: "place", index: 1 }), { ok: false, code: "condition" });
    assert.deepEqual(dropCheck(FLOW, { genre: "lien", stepId: "inconnue" }, { genre: "etape", stepId: "auteur" }), { ok: false, code: "condition" });
    assert.equal(phraseRefus("condition"), "Pas de condition libre : seuls le verdict d'une relecture et le choix d'un aiguillage changent la suite.");
  });

  it("« imbrication » : un bloc déposé SUR un bloc ou sur une étape, au lieu d'une place entre deux blocs", () => {
    assert.deepEqual(dropCheck(FLOW, { genre: "bloc", blocId: "b-un" }, { genre: "bloc", blocId: "b-avis" }), { ok: false, code: "imbrication" });
    assert.deepEqual(dropCheck(FLOW, { genre: "bloc", blocId: "b-un" }, { genre: "etape", stepId: "avis1" }), { ok: false, code: "imbrication" });
    assert.deepEqual(dropCheck(FLOW, { genre: "bloc", blocId: "b-un" }, { genre: "place", index: 2 }), { ok: true });
    assert.deepEqual(dropCheck(FLOW, { genre: "bloc", blocId: "b-inconnu" }, { genre: "place", index: 0 }), { ok: false, code: "imbrication" });
    assert.equal(phraseRefus("imbrication"), "Un bloc ne peut pas en contenir un autre.");
  });

  it("un lien accepté : vers une étape plus bas dont la place laisse le choix", () => {
    const flow = flowOf(etapeBloc("un"), avisBloc(), etapeBloc("trois", { recoit: "precedent" }));
    assert.deepEqual(dropCheck(flow, { genre: "lien", stepId: "un" }, { genre: "etape", stepId: "trois" }), { ok: true });
    assert.deepEqual(dropCheck(flow, { genre: "lien", stepId: "avis1" }, { genre: "bloc", blocId: "b-trois" }), { ok: true });
  });

  it("rien ne mène au premier bloc de travail : il part de VOTRE demande", () => {
    const flow = flowOf(etapeBloc("un"), etapeBloc("deux", { recoit: "precedent" }));
    assert.deepEqual(dropCheck(flow, { genre: "lien", stepId: "deux" }, { genre: "bloc", blocId: "b-un" }), { ok: false, code: "versLeBas" });
  });

  it("quatre codes, quatre phrases, et aucune autre (C §8.2)", () => {
    assert.deepEqual([...SCHEMA_REFUS_CODES], ["versLeBas", "retourArriere", "condition", "imbrication"]);
    assert.deepEqual(Object.keys(CONSTRUCTION_TEXTES.avance.schema.refus).sort(), [...SCHEMA_REFUS_CODES].sort());
    for (const code of SCHEMA_REFUS_CODES) assert.ok(phraseRefus(code).length > 20, code);
  });
});

// --- Propriété (200 suites, graine fixe) ---------------------------------------------------------------------------------------

describe("schéma modifiable : propriété (200 suites tirées au hasard, graine fixe)", () => {
  it("aucune suite d'opérations n'aboutit à un déroulé que le serveur refuserait sans qu'un problème soit AFFICHÉ", () => {
    let seed = 20260922;
    const alea = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const dans = <T,>(liste: readonly T[]): T | undefined => (liste.length === 0 ? undefined : liste[Math.floor(alea() * liste.length)]);
    const ctx = contexte();
    const departs = [DEUX_ETAPES(), flowOf(avisBloc()), flowOf(relectureBloc()), flowOf(aiguillageBloc()), brouillonDeForme("avis").flow];
    let opérations = 0;
    let affiches = 0;
    for (let suite = 0; suite < 200; suite++) {
      let flow = structuredClone(departs[suite % departs.length] as Flow);
      let compteur = brouillonDe(flow).compteur;
      for (let pas = 0; pas < 6; pas++) {
        const blocId = dans(blocIds(flow)) ?? "";
        const etapes = toutesLesEtapes(flow).map((etape) => etape.id);
        const stepId = dans(etapes) ?? "";
        const cible = dans(etapes) ?? "";
        const forme = dans(SCHEMA_FORMES) ?? "etape";
        const local: SchemaContext = { ...ctx, compteur };
        const tirage = Math.floor(alea() * 13);
        const resultat =
          tirage === 0
            ? insertAfter(flow, blocId, forme, local)
            : tirage === 1
              ? moveUp(flow, blocId, local)
              : tirage === 2
                ? moveDown(flow, blocId, local)
                : tirage === 3
                  ? moveTo(flow, blocId, Math.floor(alea() * 5), local)
                  : tirage === 4
                    ? removeBloc(flow, blocId, local)
                    : tirage === 5
                      ? addAvis(flow, blocId, local)
                      : tirage === 6
                        ? removeAvis(flow, blocId, stepId, local)
                        : tirage === 7
                          ? addSpecialiste(flow, blocId, local)
                          : tirage === 8
                            ? removeSpecialiste(flow, blocId, stepId, local)
                            : tirage === 9
                              ? transform(flow, blocId, forme, local)
                              : tirage === 10
                                ? setRecoit(flow, stepId, [cible], local)
                                : tirage === 11
                                  ? setTours(flow, blocId, alea() < 0.5 ? 1 : 2, local)
                                  : setChoixMax(flow, blocId, alea() < 0.5 ? 1 : 2, local);
        opérations += 1;
        // 1. Ce que l'opération rend est exactement ce que le serveur dira du déroulé rendu (C §11 S4).
        assert.deepEqual(resultat.problemes, validateFlow(resultat.flow, ctx.validation), `suite ${suite}, pas ${pas}, tirage ${tirage}`);
        // 2. Chaque problème BLOQUANT est affiché : sur l'équipe, sur son bloc, ou sur son étape.
        const modele = schemaModel(resultat.flow, resultat.problemes, local);
        const vus = new Set([
          ...modele.problemes.map((probleme) => probleme.code),
          ...modele.lignes.flatMap((ligne) => [...ligne.problemes.map((p) => p.code), ...ligne.etapes.flatMap((etape) => etape.problemes.map((p) => p.code))]),
        ]);
        for (const probleme of resultat.problemes) {
          if (!probleme.bloquant) continue;
          affiches += 1;
          assert.ok(vus.has(probleme.code), `problème ${probleme.code} non affiché (suite ${suite}, pas ${pas}, tirage ${tirage})`);
        }
        // 3. Un refus ne change jamais le déroulé, et un déroulé inchangé n'est jamais un objet neuf.
        if (resultat.refus !== null) assert.equal(resultat.change, false);
        flow = resultat.flow;
        compteur = resultat.compteur;
        assert.equal(flow.version, FLOW_VERSION);
      }
    }
    assert.ok(opérations === 1200, `contrôle discriminant : ${opérations} opérations jouées`);
    assert.ok(affiches > 100, `contrôle discriminant : ${affiches} problèmes bloquants rencontrés et affichés`);
  });
});

// --- Modèle de la vue ---------------------------------------------------------------------------------------------------------

describe("schéma modifiable : modèle de la vue", () => {
  const SCHEMA = CONSTRUCTION_TEXTES.avance.schema;

  it("une ligne par ligne du schéma, ses menus et ses actions (chaque glisser a son bouton ou son menu)", () => {
    const flow = flowOf(etapeBloc("un"), avisBloc());
    const modele = schemaModel(flow, validateFlow(flow, validation()), contexte());
    assert.deepEqual(
      modele.lignes.map((ligne) => ligne.kind),
      ["etape", "avis", "synthese"],
    );
    assert.equal(modele.aide, "Glissez vers une étape plus bas : elle recevra ce résultat.");
    const premiere = modele.lignes[0];
    assert.equal(premiere?.monter.possible, false, "le premier bloc ne monte pas");
    assert.equal(premiere?.descendre.possible, true);
    assert.equal(premiere?.monter.libelle, SCHEMA.menus.monter);
    assert.equal(premiere?.descendre.libelle, SCHEMA.menus.descendre);
    assert.equal(premiere?.supprimer.libelle, SCHEMA.menus.supprimer);
    assert.equal(premiere?.ajouterApres.libelle, SCHEMA.menus.ajouterApres);
    assert.equal(premiere?.transformer.libelle, SCHEMA.menus.transformer);
    assert.deepEqual(
      premiere?.ajouterApres.choix.map((choix) => choix.forme),
      [...SCHEMA_FORMES],
    );
    assert.equal(premiere?.ajouterApres.choix.find((choix) => choix.forme === "aiguillage")?.possible, false, "un aiguillage n'est que premier");
  });

  it("le schéma garde toujours un bloc : le dernier ne se supprime pas (les étapes restent le chemin complet)", () => {
    const deux = flowOf(etapeBloc("un"), etapeBloc("deux", { recoit: "precedent" }));
    assert.equal(schemaModel(deux, [], contexte()).lignes[0]?.supprimer.possible, true);
    const seul = flowOf(etapeBloc("un"));
    assert.equal(schemaModel(seul, [], contexte()).lignes[0]?.supprimer.possible, false);
  });

  it("« Reçoit le résultat de… » : les étapes situées PLUS HAUT, et rien d'autre ; jamais sur le premier bloc", () => {
    const flow = flowOf(etapeBloc("un"), avisBloc(), etapeBloc("trois", { recoit: "precedent" }));
    const modele = schemaModel(flow, validateFlow(flow, validation()), contexte());
    const premiere = modele.lignes[0]?.etapes[0];
    assert.equal(premiere?.recoit, null, "le premier bloc part de votre demande");
    const avis = modele.lignes[1]?.etapes[0];
    assert.equal(avis?.recoit, null, "l'entrée d'un avis est imposée");
    const derniere = modele.lignes.at(-1)?.etapes[0];
    assert.equal(derniere?.recoit?.libelle, SCHEMA.menus.recevoir);
    assert.deepEqual(
      derniere?.recoit?.choix.map((choix) => choix.stepId),
      ["un", "avis1", "avis2", "synthese"],
    );
    assert.equal(
      derniere?.recoit?.choix.every((choix) => !choix.cochee),
      true,
    );
    const lie = setRecoit(flow, "trois", ["un"], contexte());
    const apres = schemaModel(lie.flow, lie.problemes, contexte());
    assert.deepEqual(
      apres.lignes.at(-1)?.etapes[0]?.recoit?.choix.filter((choix) => choix.cochee).map((choix) => choix.stepId),
      ["un"],
    );
    assert.deepEqual(apres.lignes.at(-1)?.recoitDe, ["un"]);
  });

  it("les problèmes sont rendus SUR le bloc ou l'étape fautifs, avec leur phrase (T4t, §4.3)", () => {
    const flow = flowOf(etapeBloc("un", { titre: "" }), aiguillageBloc({ choixMax: 2 }));
    const problems = validateFlow(flow, validation());
    const modele = schemaModel(flow, problems, contexte());
    const titre = modele.lignes[0]?.etapes[0]?.problemes.find((probleme) => probleme.code === "titre");
    assert.equal(titre?.texte, TEAM_TEXTES.partout.problemes.titre);
    assert.equal(titre?.bloquant, true);
    const aiguillage = modele.lignes[1]?.problemes.find((probleme) => probleme.code === "synthese-requise");
    assert.equal(aiguillage?.texte, "Avec 2 spécialistes possibles, ajoutez une étape de synthèse.", "un aiguillage ne parle pas des avis");
    const vide = schemaModel(flowOf(), validateFlow(flowOf(), validation()), contexte());
    assert.equal(vide.problemes.find((probleme) => probleme.code === "vide")?.texte, TEAM_TEXTES.partout.problemes.vide);
  });

  it("[Voir le JSON] : lecture seule, le déroulé tel quel, avec la phrase qui renvoie à « Dupliquer »", () => {
    const flow = flowOf(etapeBloc("un"));
    const modele = schemaModel(flow, [], contexte());
    assert.equal(modele.json.voir, "Voir le JSON");
    assert.equal(modele.json.lectureSeule, "Lecture seule. Pour partager une équipe, utilisez « Dupliquer » ; l'import viendra plus tard.");
    assert.equal(modele.json.texte, JSON.stringify(flow, null, 2));
  });

  it("avis et spécialistes : leurs commandes suivent les bornes, et la synthèse ne se retire pas", () => {
    const modele = schemaModel(flowOf(avisBloc()), [], contexte());
    assert.equal(modele.lignes[0]?.ajouterEtape, TEAM_TEXTES.partout.editeur.ajouterAvis);
    assert.equal(modele.lignes[0]?.etapes[0]?.retirer, null, "2 avis : la borne basse est atteinte");
    assert.equal(modele.lignes[1]?.etapes[0]?.retirer, null, "une synthèse ne se retire pas");
    const trois = addAvis(flowOf(avisBloc()), "b-avis", contexte());
    const apres = schemaModel(trois.flow, [], contexte());
    assert.equal(apres.lignes[0]?.etapes[0]?.retirer, TEAM_TEXTES.partout.editeur.retirerAvis);
    const aiguillage = schemaModel(flowOf(aiguillageBloc()), [], contexte());
    assert.equal(aiguillage.lignes[0]?.ajouterEtape, CONSTRUCTION_TEXTES.partout.editeur.ajouterSpecialiste);
    assert.equal(aiguillage.lignes[0]?.choixMax?.libelle, CONSTRUCTION_TEXTES.partout.editeur.champs.specialistesMax);
    assert.deepEqual(aiguillage.lignes[0]?.choixMax?.choix, [1, 2]);
    const relecture = schemaModel(flowOf(relectureBloc()), [], contexte());
    assert.equal(relecture.lignes[0]?.tours?.libelle, CONSTRUCTION_TEXTES.partout.editeur.champs.tours);
    assert.deepEqual(relecture.lignes[0]?.tours?.choix, [1, 2]);
    assert.equal(relecture.lignes[0]?.ajouterEtape, null);
  });
});

// --- Le serveur revalide (C §11 S4) ---------------------------------------------------------------------------------------------

describe("schéma modifiable : le navigateur n'est jamais la seule autorité (C §11 S4)", () => {
  const SERVER = import.meta.dirname;
  const lireServeur = (fichier: string) => fs.readFileSync(path.join(SERVER, fichier), "utf8");

  it("le serveur revalide à l'ENREGISTREMENT, dans le mode courant, et refuse 422 quand un problème bloque", () => {
    const service = lireServeur("team-service.ts");
    assert.match(service, /validateFlow\(flow, \{[^}]*pour: "enregistrement"/);
    assert.match(service, /const problems = problemesDe\(flow, assistants, courant, methodes\);[\s\S]{0,400}refuse\(422, "equipe-invalide"/);
  });

  it("le serveur revalide au LANCEMENT, dans le mode courant, sur les assistants de l'instantané", () => {
    const preflight = lireServeur("team-preflight.ts");
    assert.match(preflight, /validateFlow\(flow, \{[\s\S]{0,200}pour: "lancement"/);
    assert.match(preflight, /refus\(422, "equipe-invalide", \{ problems: bloquants \}\)/);
  });

  it("la revalidation du navigateur ne juge que la STRUCTURE : les problèmes qui demandent les assistants restent au serveur", () => {
    const flow = flowOf(etapeBloc("un", { assistant: "assistant-inconnu" }));
    const codes = problemesStructurels(flow).map((probleme) => probleme.code);
    assert.equal(codes.includes("assistant-absent"), false, "le navigateur n'a pas les règles effectives des assistants");
    for (const code of PROBLEMES_DES_ASSISTANTS) assert.equal(codes.includes(code), false, code);
    // Les problèmes de structure, eux, sont dits tout de suite : ici, le titre manquant.
    assert.deepEqual(problemesStructurels(flowOf(etapeBloc("un", { titre: "" }))).map((probleme) => probleme.code), ["titre"]);
    // Et le serveur, lui, les voit tous : la revalidation locale ne le remplace pas.
    assert.ok(validateFlow(flow, validation()).some((probleme) => probleme.code === "assistant-absent"));
  });

  it("fusionnerProblemes : l'aperçu du serveur d'abord, la structure en complément, jamais deux fois le même", () => {
    const duServeur = [{ code: "titre" as const, bloc: "b-un", etape: "un", bloquant: true }];
    const locaux = [
      { code: "titre" as const, bloc: "b-un", etape: "un", bloquant: true },
      { code: "vide" as const, bloc: null, etape: null, bloquant: true },
    ];
    assert.deepEqual(
      fusionnerProblemes(duServeur, locaux).map((probleme) => probleme.code),
      ["titre", "vide"],
    );
  });
});

// --- Interface et feuille (relues en statique) ---------------------------------------------------------------------------------

describe("schéma modifiable : interface relue en statique", () => {
  const WEB = path.join(import.meta.dirname, "..", "web", "pages", "assistants", "teams");
  const lire = (fichier: string) => fs.readFileSync(path.join(WEB, fichier), "utf8");
  const editeur = lire("SchemaEditor.tsx");
  const css = lire("schema.css");
  /** Source sans commentaires (positions gardées) : un commentaire ne vaut jamais une preuve. */
  const sansCommentaires = (texte: string) => texte.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const code = sansCommentaires(editeur);

  /** Corps de chaque gestionnaire `nom={…}` d'un source JSX, accolades appariées. */
  function corpsDe(source: string, nom: string): string[] {
    const out: string[] = [];
    const marque = `${nom}={`;
    let at = source.indexOf(marque);
    while (at !== -1) {
      let profondeur = 0;
      let fin = at + marque.length - 1;
      for (; fin < source.length; fin++) {
        if (source[fin] === "{") profondeur += 1;
        else if (source[fin] === "}" && --profondeur === 0) break;
      }
      out.push(source.slice(at + marque.length, fin));
      at = source.indexOf(marque, fin);
    }
    return out;
  }

  it("le squelette de L42d a laissé la place à l'implémentation (plus de mention « Propriétaire : L43 » de squelette)", () => {
    assert.equal(/SQUELETTE/i.test(editeur), false);
    assert.match(editeur, /Propriétaire : L43\./);
    assert.match(code, /schemaModel\(/);
  });

  it("glisser aux événements `pointer` natifs, SANS bibliothèque (P8 : aucune dépendance npm nouvelle)", () => {
    for (const re of [/onPointerDown=/, /onPointerMove=/, /onPointerUp=/, /setPointerCapture|releasePointerCapture/]) assert.match(code, re);
    const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
    for (const spec of imports) assert.ok(spec.startsWith(".") || spec === "react", `import refusé : ${spec}`);
    assert.equal(/\bdraggable\b/.test(code), false, "le glisser natif HTML5 ne se pilote pas au clavier");
  });

  it("un CLIC reste un clic : le glisser ne s'arme qu'au-delà d'un seuil, et l'appui ne vole pas le focus de la ligne", () => {
    // Le seuil existe, et il se mesure au déplacement du pointeur.
    assert.match(code, /SEUIL_GLISSER/);
    assert.match(code, /Math\.hypot\(/);
    // Les gestionnaires d'appui n'ouvrent qu'une INTENTION : ni `preventDefault` (qui supprime le `mousedown` de
    // compatibilité, donc la prise de focus à la souris, celle qui arme Alt+↑ / Alt+↓), ni pose du glisser.
    const appuis = corpsDe(code, "onPointerDown");
    assert.ok(appuis.length >= 2, `gestionnaires d'appui trouvés : ${appuis.length}`);
    for (const corps of appuis) {
      assert.equal(/preventDefault/.test(corps), false, corps);
      assert.equal(/\bcommencer\s*\(/.test(corps), false, corps);
      assert.match(corps, /\bviser\s*\(/);
    }
    // Contrôles discriminants : le lecteur de corps voit bien ce qu'un gestionnaire contient, accolades imbriquées comprises.
    assert.deepEqual(corpsDe("<li onPointerDown={(e) => { if (x) { f(e); } }} />", "onPointerDown"), ["(e) => { if (x) { f(e); } }"]);
    assert.ok(corpsDe("<li onPointerDown={(e) => { e.preventDefault(); }} />", "onPointerDown")[0]?.includes("preventDefault"));
    // Sous le seuil, aucun glisser n'a été posé : `lacher` sort avant toute consultation de `dropCheck`, donc aucun refus
    // n'est écrit ni annoncé pour un geste qui n'a pas eu lieu.
    assert.match(code, /const lacher = useCallback\([\s\S]{0,300}if \(glisse === null\) return;/);
    const corpsLacher = code.slice(code.indexOf("const lacher = useCallback("));
    assert.ok(corpsLacher.indexOf("if (glisse === null) return;") < corpsLacher.indexOf("dropCheck("), "dropCheck consulté avant la sortie");
    // Un bloc reposé sur lui-même ne se voit rien reprocher non plus.
    assert.match(code, /cible\.blocId === source\.blocId/);
  });

  it("le glisser dépose sur une PLACE, et la place est convertie en rang par le module pur (moveToPlace)", () => {
    assert.match(code, /moveToPlace\(/);
    assert.equal(/\bmoveTo\(/.test(code), false, "la vue ne parle qu'en places : le rang est l'affaire du module pur");
    assert.match(code, /data-sc-place=\{index\}/);
  });

  it("chaque glisser a son bouton ou son menu (WCAG 2.5.7) : Alt+↑ / Alt+↓ et les six entrées du §4.3", () => {
    assert.match(code, /altKey/);
    assert.match(code, /ArrowUp/);
    assert.match(code, /ArrowDown/);
    for (const entree of ["monter", "descendre", "supprimer", "ajouterApres", "transformer", "recoit"]) {
      assert.ok(code.includes(entree), entree);
    }
    assert.match(code, /moveUp|moveDown/);
    assert.equal(/<button[^>]*\sdisabled/.test(code), false, "un bouton impossible garde son focus et sa raison (aria-disabled)");
    assert.match(code, /aria-disabled=/);
  });

  it("refus : écrit PRÈS DE LA CIBLE et annoncé poliment, jamais par la couleur seule", () => {
    assert.match(code, /refus/);
    assert.match(code, /dropCheck\(/);
    assert.match(code, /onAnnonce\(/);
    assert.equal(/aria-live=/.test(code), false, "aucune région d'annonce nouvelle : celle de la page suffit");
  });

  it("[Voir le JSON] en LECTURE SEULE, copiable ; aucun import de déroulé", () => {
    assert.match(code, /readOnly/);
    assert.match(code, /json\.lectureSeule/);
    assert.equal(/onChange=\{[^}]*json/.test(code), false);
  });

  it("aucun texte d'interface écrit dans le composant : tout vient du modèle", () => {
    // Deux règles, commentaires retirés : aucune lettre accentuée dans le code (une phrase française en porte), et aucun texte
    // écrit entre deux balises JSX (tout contenu est une expression `{…}`).
    const accents = /[À-ÖØ-öø-ÿ]/;
    const texteJsx = /> *[A-Za-zÀ-ÿ][^\n<>{}()=;:]*</;
    assert.equal(accents.test(code), false, "lettre accentuée dans le code : un texte y est écrit");
    assert.equal(texteJsx.test(code), false, "texte écrit entre deux balises JSX");
    // Contrôles discriminants : les deux règles refusent bien un composant qui écrirait son texte.
    assert.equal(accents.test('const x = "Schéma modifiable";'), true);
    assert.equal(texteJsx.test("<p>Schema modifiable</p>"), true);
    assert.equal(texteJsx.test("<p>{modele.aide}</p>"), false);
  });

  it("même historique d'annulation que l'éditeur : le composant n'en tient aucun", () => {
    assert.equal(/historiqueDe|EditHistory|useReducer/.test(code), false);
    assert.match(code, /onOperation\(/);
  });

  it("feuille : bloc @media (forced-colors: active) non vide (test de T4w), aucune animation infinie", () => {
    const debut = css.indexOf("@media (forced-colors: active)");
    assert.notEqual(debut, -1, "aucun bloc de contraste forcé");
    const bloc = css.slice(debut);
    assert.ok(bloc.length > 100, "bloc de contraste forcé vide");
    assert.ok(/CanvasText/.test(bloc), "traits en CanvasText");
    assert.ok(/Highlight/.test(bloc), "focus en Highlight");
    assert.equal(/animation[^;]*infinite/.test(css), false);
    assert.equal(/animation\s*:/.test(css), false, "aucune animation");
    if (/transition/.test(css)) assert.ok(css.includes("prefers-reduced-motion"), "mouvement hors du garde-fou");
    // La règle du glisser fait ce que son commentaire annonce : la sélection de texte est écartée (le `preventDefault` de
    // l'appui, qui s'en chargeait, a disparu avec le seuil), et le contenu continue de capter le pointeur.
    assert.match(css, /\.sc-ligne\.sc-glisse \{[^}]*user-select: none;/);
    assert.equal(/ne capte pas le pointeur/.test(css), false, "commentaire démenti par la règle");
  });
});
