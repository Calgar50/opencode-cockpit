// Propriétaire : L38b.
// Modèle PUR des cartes d'équipe du chat (D-eq-24 : toute la logique ici, les .tsx restent minces) : TeamRunView → genre de carte,
// en-tête, lignes d'étapes (icône ET mot, jamais la couleur seule, §2.3 l.107-117), textes de pause, boutons, texte de verrou
// (D-eq-16) et présence de la carte de résultat (`resultMessageId === null`). Spécification §5.1 l.876-881, §7.8 l.1184, §3.12
// l.392 ; C §9.5, §9.6 ; plan it4 §6 fiche L38b, §4.1.1.
// Aucun texte écrit ici : tout vient de server/shared/team-texts.ts (T4t). Montants écrits par montant() ou par remplir() avec un
// nombre, JAMAIS par formatUsd(), qui ajoute déjà « $ » (report MX-EQ au train de V0, §4.2).
// Relance (D-eq-17, A4) : estimation d'abord au clic, confirmation ensuite, `relancer` jamais sans empreinte ; la relance n'est
// PAS proposée quand les équipes sont fermées dans le mode courant (U1, §2.6 : le serveur y répond 403).
// Aucun bouton que le serveur refuserait : l'arrêt n'est composé que pour les états d'ETATS_VERROU (ailleurs, POST …/stop rend
// 409 `etat-incompatible`), et une équipe `terminee` a son genre à elle, la carte de résultat prenant la suite.
// 5b (L42c) : relecture et aiguillage. Une ligne par TOUR réellement fait (« tour {n} », « ×{n} » sur le bloc), le verdict d'une
// relecture en MOT et icône, l'état « Non choisi » des spécialistes écartés, la carte de choix d'un aiguillage (proposition avec
// la raison masquée, cases, « {n} au maximum. », trois boutons) et le journal de relecture replié sous le résultat. Les phrases
// viennent de server/shared/construction-texts.ts (T5a) par server/shared/team-choice-view.ts (pur).
// Testé par server/web-team-cards.test.ts et server/team-deroule-c5.test.ts ; aucun composant (.tsx) importé, aucun appel réseau.
import {
  aucunDuLivrable,
  CHOIX_RAISON_MAX,
  type ChoixPropose,
  journalRelecture,
  optionsDe,
  selectionInitiale,
  type TeamAucunView,
  type TeamChoiceView,
  vueChoix,
} from "../../../../server/shared/team-choice-view.ts";
import { TEXTES as CONSTRUCTION } from "../../../../server/shared/construction-texts.ts";
import { FLOW_LIMITS } from "../../../../server/shared/team-limits.ts";
import { pauseChangement, phraseBlocage, phraseErreur, remplir, resumeResultat, TEXTES } from "../../../../server/shared/team-texts.ts";
import type { StepRunView, TeamEstimateResponse, TeamPauseView, TeamRunState, TeamRunView, TeamStepState } from "../../../../server/shared/team-types.ts";
import { formatDuration } from "../../../lib/format.ts";
import { boundedAiText } from "../turn.ts";

const P = TEXTES.partout;
/** Phrases de la construction (5b) : relecture, aiguillage, « Non choisi », « ×{n} » et les écarts Prévu / Réel. */
const C5 = CONSTRUCTION.partout.execution;

/** Icônes d'Icon.tsx utilisées par les cartes ; l'état est TOUJOURS dit par le mot à côté (§2.3, jamais la couleur seule). */
export type TeamIconName = "alert" | "check" | "circle" | "coins" | "gauge" | "hourglass" | "lock" | "minus" | "pause" | "plug" | "pulse" | "stop" | "x";

/** Icône de chaque état d'étape (TeamStepState). */
export const STEP_ICONS: Readonly<Record<TeamStepState, TeamIconName>> = {
  prevue: "circle",
  "en-file": "hourglass",
  "en-cours": "pulse",
  "attente-accord": "lock",
  terminee: "check",
  echec: "x",
  arretee: "stop",
  interrompue: "plug",
  plafond: "gauge",
  "non-lancee": "minus",
  // <c5:icone-non-choisi>
  // 5b (L42c) : « Non choisi » porte l'icône `minus` demandée par la fiche — un spécialiste écarté n'a rien envoyé, donc ni
  // barre ni coût dans le Déroulé (deroule-model.ts). Le MOT « Non choisi » est toujours écrit à côté (§2.3).
  "non-choisi": "minus",
  // </c5:icone-non-choisi>
};

/** Icône de chaque état de lancement (TeamRunState). */
export const RUN_ICONS: Readonly<Record<TeamRunState, TeamIconName>> = {
  preparation: "circle",
  "en-cours": "pulse",
  "attente-verification": "pause",
  "attente-budget": "coins",
  "attente-modification": "alert",
  // <c5:icone-attente-choix>
  // 5b (L42c) : l'attente de votre choix porte l'icône des autres pauses — c'est bien une pause, et la carte de choix
  // (proposition, raison masquée, cases, trois boutons) est rendue dessous par TeamPauseCard.
  "attente-choix": "pause",
  // </c5:icone-attente-choix>
  terminee: "check",
  arretee: "stop",
  echec: "x",
  interrompue: "plug",
  plafond: "gauge",
};

/** États qui verrouillent la saisie (D-eq-16) : `interrompue`, `plafond`, `echec` et `terminee` ne verrouillent PAS. */
export const ETATS_VERROU: ReadonlySet<TeamRunState> = new Set<TeamRunState>([
  "preparation",
  "en-cours",
  "attente-verification",
  "attente-budget",
  "attente-modification",
  // <c5:verrou-attente-choix>
  // 5b (L42c) : une équipe qui attend votre choix travaille encore — elle verrouille la saisie et peut être arrêtée, comme les
  // autres attentes, et [Arrêter l'équipe] est justement le troisième bouton de la carte de choix.
  "attente-choix",
  // </c5:verrou-attente-choix>
]);

/** Cartes finales (D-eq-22 : [Ajouter les résultats obtenus à la conversation] y est proposé). */
export const ETATS_FINAUX: ReadonlySet<TeamRunState> = new Set<TeamRunState>(["arretee", "plafond", "echec", "interrompue"]);

/**
 * Attentes : la carte montre alors la pause, jamais l'en-tête d'exécution.
 * 5b (L42c) : « attente-choix » en fait partie — sans elle, la carte de choix d'un aiguillage ne serait jamais rendue et
 * l'équipe resterait arrêtée sur un écran d'exécution ordinaire.
 */
export const ETATS_ATTENTE: ReadonlySet<TeamRunState> = new Set<TeamRunState>([
  "attente-verification",
  "attente-budget",
  "attente-modification",
  "attente-choix",
]);

/** États dont POST …/fermer fait une équipe `arretee` (plan §4.1.5) ; `arretee` n'a plus rien à fermer. */
const ETATS_FERMABLES: ReadonlySet<TeamRunState> = new Set<TeamRunState>(["interrompue", "plafond", "echec"]);

/** Titre d'équipe, titre d'étape et message de pause : écrits par vous ou par un exemple, montrés en texte, bornés. */
const TITRE_MAX = 120;
const MESSAGE_MAX = 600;

// 5b : la carte de choix et [Envoyer à cet assistant] ne passent PAS par TeamButton (leurs libellés suivent les cases cochées
// et le livrable) : cette union reste celle de l'itération 4, sans membre qui ne servirait à rien.
export type TeamAction = "arreter" | "continuer" | "relancer" | "ajouter-resultats" | "fermer" | "ajouter";

export interface TeamButton {
  action: TeamAction;
  libelle: string;
  /** Allure : le premier choix de la carte est en « primary », l'arrêt en « danger », le reste ordinaire. */
  allure: "primary" | "normal" | "danger";
  /** aria-disabled : le bouton reste focalisable pour que sa raison soit lue. */
  desactive: boolean;
  raison: string | null;
}

export interface TeamStepLine {
  /** Clé de rendu : étape, tour et tentative (une ligne par tentative affichée). */
  cle: string;
  kind: "etape" | "pause";
  titre: string;
  /** « {titre} · {assistant} · {ia} » (gabarit `execution.ligne`) ; vide pour la ligne de pause. */
  detail: string;
  icone: TeamIconName;
  /** Mot de l'état, lu à côté de l'icône (jamais la couleur seule). */
  mot: string;
  /** Session d'étape à ouvrir dans le tiroir de lecture ; null : [Voir son travail] absent. */
  sessionId: string | null;
  /** Libellé de [Voir son travail] ; null quand il n'y a pas de session d'étape à ouvrir. */
  voirTravail: string | null;
  /** « tentative {n} » à partir de la deuxième. */
  tentative: string | null;
  /** 5b : « tour {n} » à partir du deuxième tour d'une relecture ; null ailleurs. */
  tour: string | null;
  /** 5b : verdict d'une relecture, en MOT et icône (jamais la couleur seule) ; null hors d'une étape de relecture. */
  verdict: { mot: string; icone: TeamIconName } | null;
  /** 5b : « ×{n} » quand le bloc a travaillé plusieurs tours ; null sinon. */
  repetition: string | null;
  /** « Réponse peut-être incomplète… » quand l'étape a atteint sa limite d'actions. */
  tronquee: string | null;
  /** Phrase de la cause d'un échec ou d'un arrêt ; null sans cause. */
  cause: string | null;
}

/**
 * Verdict d'une étape de relecture (5b) : le MOT et son icône. `undefined` (champ absent) = l'étape n'est pas une relecture ;
 * `null` = c'est une relecture, mais le verdict n'était pas lisible — le cockpit le dit et le traite comme « à reprendre »,
 * jamais comme une relecture réussie.
 */
export function verdictLigne(verdict: StepRunView["verdict"]): { mot: string; icone: TeamIconName } | null {
  if (verdict === undefined) return null;
  if (verdict === "rien-a-reprendre") return { mot: C5.relecture.rienAReprendre, icone: "check" };
  if (verdict === "a-reprendre") return { mot: C5.relecture.aReprendre, icone: "alert" };
  return { mot: C5.relecture.verdictIllisible, icone: "alert" };
}

export interface TeamPauseModel {
  kind: TeamPauseView["kind"];
  titre: string;
  message: string;
  /** « Résultat de « {titre} » (extrait) : » et le texte transmis, modifiable ; null hors d'une pause de vérification. */
  resume: { entete: string; libelle: string; texte: string; max: number } | null;
  precision: { libelle: string; aide: string; max: number } | null;
  /** « Rien n'est facturé pendant la pause. » ; null quand le message le dit déjà. */
  gratuite: string | null;
  /** Une pause de budget confirme le garde-fou (x-cockpit-confirm: 1). */
  confirme: boolean;
  boutons: TeamButton[];
  /**
   * 5b : entrée BORNÉE de la carte de choix d'un aiguillage ; null hors d'une pause « choix ». La carte, elle, est recalculée à
   * chaque case cochée par `modeleChoix(entree, selection)` : c'est la seule chose que le composant fait lui-même.
   */
  choix: TeamChoixEntree | null;
  // <c5:reprise-redemarrage>
  /**
   * Clôture 5b (D-5b-1) : pause reprise après un redémarrage du cockpit, sans estimation à jour de la suite ; null sinon. Tant
   * qu'elle est là, [Continuer] n'est pas proposé (le serveur le refuserait) : [Refaire l'estimation de la suite] le remplace.
   */
  reprise: TeamRepriseModel | null;
  // </c5:reprise-redemarrage>
}

// <c5:reprise-redemarrage>
/**
 * Pause reprise après un redémarrage du cockpit (D-5b-1). `note` dit ce qui s'est passé et ce qu'il reste à faire ; `bouton`
 * est le libellé de [Refaire l'estimation de la suite], absent quand la demande n'est plus reconstituable (aucune étape ne peut
 * plus partir) ; `raison` est lue à côté des réponses qui attendent la nouvelle estimation ; `aucunLibre` : pause de choix où
 * « Aucun ne convient » répond sans elle, puisqu'il ne lance rien.
 */
export interface TeamRepriseModel {
  note: string;
  bouton: string | null;
  raison: string;
  aucunLibre: boolean;
}

const REPRISE = CONSTRUCTION.partout.execution.reprise;

/** Modèle de la reprise d'une pause, lu sur `pause.reestimation` (vue du serveur) ; null quand l'estimation est à jour. */
export function modeleReprise(pause: TeamPauseView): TeamRepriseModel | null {
  const attente = pause.reestimation;
  if (attente === undefined) return null;
  const aucunLibre = pause.kind === "choix" && attente.aucunLibre;
  const phrases = attente.possible ? [REPRISE.note] : [REPRISE.impossible, REPRISE.impossibleSuite];
  if (aucunLibre) phrases.push(REPRISE.aucunLibre);
  return { note: phrases.join(" "), bouton: attente.possible ? REPRISE.bouton : null, raison: REPRISE.raison, aucunLibre };
}
// </c5:reprise-redemarrage>

/** Entrée bornée de la carte de choix : ce que la pause porte, textes d'IA déjà coupés (CHOIX_RAISON_MAX). */
export interface TeamChoixEntree {
  options: ChoixPropose[];
  raison: string;
  choixMax: number;
  /** Coût de la SUITE du chemin, porté par le bouton [Continuer avec {n} spécialiste(s) (≈ {x} $)]. */
  suiteUsd: number;
}

export interface TeamResultModel {
  titre: string;
  redige: string;
  /** Avancé, §3.13 l.413 : « IA de l'étape : … (choisie par l'équipe) » quand l'équipe a choisi l'IA ; null sinon. */
  iaEquipe: string | null;
  resume: string;
  aVerifier: string;
  /** Libellé de [Ajouter à la conversation] (mode carte seule). */
  ajouter: string;
  /** Texte du résultat, rendu par le composant Markdown existant (échappé) ; vide : rien à montrer. */
  texte: string;
  /**
   * 5b : journal de relecture, REPLIÉ sous le résultat (C §9.6). Le livrable n'est pas réécrit : il est seulement découpé, le
   * journal d'un côté, le résultat de l'autre. null quand le livrable n'en porte aucun.
   */
  journal: { titre: string; texte: string } | null;
  /** 5b : notes de relecture (« Non relue après la dernière correction. », « Relecture non conclue après {n} tours … »). */
  notes: string[];
  /**
   * 5b : chemin « aucun ne convient » d'un aiguillage (D-5-13), reconnu SUR LE LIVRABLE — seul endroit où l'assistant de repli
   * parvient à l'interface. Les deux phrases restent dans `texte` (le livrable est rendu tel quel) ; ce champ n'ajoute que le
   * bouton [Envoyer à cet assistant]. null : ce résultat n'est pas celui d'un « aucun ».
   */
  aucun: TeamAucunView | null;
}

export interface TeamRunCardModel {
  runId: string;
  /** `terminee` : l'équipe a fini, la carte de résultat prend la suite ; ni en-tête d'exécution, ni bouton d'arrêt. */
  genre: "execution" | "pause" | "finale" | "terminee";
  /** En-tête de la carte d'exécution, ou titre de la carte finale. */
  entete: string;
  etatMot: string;
  etatIcone: TeamIconName;
  lignes: TeamStepLine[];
  /** Carte finale : phrase de l'état ; null ailleurs. */
  message: string | null;
  /** Carte finale : « Étapes terminées : {k} sur {total} · {cout} $ ». */
  bilan: string | null;
  pause: TeamPauseModel | null;
  boutons: TeamButton[];
  /** Texte de verrou de la saisie (D-eq-16) ; null : saisie libre. */
  verrou: string | null;
  /** Carte de résultat rendue ICI (une seule carte de résultat : `resultMessageId === null`). */
  resultat: TeamResultModel | null;
  /** Transition annoncée poliment par la région de la page (L5b) : le mot de l'état. */
  annonce: string;
}

const texte = (valeur: unknown, max: number) => boundedAiText(valeur, max).text;

/** Dernière tentative de chaque étape, dans l'ordre d'exécution. */
export function etapesVisibles(run: TeamRunView): StepRunView[] {
  const par = new Map<string, StepRunView>();
  for (const step of run.steps) {
    const vu = par.get(step.stepId);
    if (!vu || step.tour > vu.tour || (step.tour === vu.tour && step.tentative >= vu.tentative)) par.set(step.stepId, step);
  }
  return [...par.values()].sort((a, b) => a.ordre - b.ordre);
}

/**
 * Une étape a-t-elle commencé ? Son ÉTAT seul le dit : « prevue » et « non-lancee » (itération 4) n'ont rien envoyé, et
 * « non-choisi » (5b) non plus — un spécialiste écarté n'a jamais travaillé.
 */
const aCommence = (step: StepRunView): boolean => step.state !== "prevue" && step.state !== "non-lancee" && step.state !== "non-choisi";

/**
 * 5b (L42c) : une ligne par TOUR réellement fait, dans l'ordre du plan. Pour les formes de l'itération 4, chaque étape n'a qu'un
 * tour et le résultat est exactement celui d'`etapesVisibles` (non-régression). Pour une relecture, les tours déjà faits ont
 * chacun leur ligne ; les tours que le plan réserve mais qui n'ont pas eu lieu n'en ont AUCUNE — le cockpit ne montre pas comme
 * fait ce qui ne l'est pas. Une étape qui n'a jamais commencé garde une seule ligne (« Pas encore commencée », « Non lancée »
 * ou « Non choisi »).
 */
export function etapesParTour(run: TeamRunView): StepRunView[] {
  const parEtape = new Map<string, Map<number, StepRunView>>();
  for (const step of run.steps) {
    const tours = parEtape.get(step.stepId) ?? new Map<number, StepRunView>();
    const vu = tours.get(step.tour);
    if (!vu || step.tentative >= vu.tentative) tours.set(step.tour, step);
    parEtape.set(step.stepId, tours);
  }
  const out: StepRunView[] = [];
  for (const tours of parEtape.values()) {
    const lignes = [...tours.values()].sort((a, b) => a.tour - b.tour);
    const faits = lignes.filter(aCommence);
    const dernier = faits.length === 0 ? 0 : Math.max(...faits.map((step) => step.tour));
    out.push(...(dernier === 0 ? lignes.slice(0, 1) : lignes.filter((step) => step.tour <= dernier)));
  }
  return out.sort((a, b) => a.ordre - b.ordre || a.tour - b.tour);
}

/**
 * 5b : tours comptés bloc par bloc, sur les lignes que `retenir` accepte. Un bloc compte le PLUS PETIT nombre de tours parmi
 * ses étapes : dans une relecture, l'auteur écrit un jet de plus que le relecteur ne rend de verdicts (`relectureOrder` de
 * team-limits.ts ajoute la révision finale), et un tour n'est un tour que lorsque la relecture a eu lieu (C §6.2). Un bloc dont
 * aucune ligne n'est retenue n'a pas d'entrée : l'appelant décide quoi en dire, rien n'est supposé à sa place.
 */
function toursDesBlocs(run: TeamRunView, retenir: (step: StepRunView) => boolean): Map<number, number> {
  const parBloc = new Map<number, Map<string, Set<number>>>();
  for (const step of run.steps) {
    if (!retenir(step)) continue;
    const etapes = parBloc.get(step.blocIndex) ?? new Map<string, Set<number>>();
    const tours = etapes.get(step.stepId) ?? new Set<number>();
    tours.add(step.tour);
    etapes.set(step.stepId, tours);
    parBloc.set(step.blocIndex, etapes);
  }
  const out = new Map<number, number>();
  for (const [blocIndex, etapes] of parBloc) out.set(blocIndex, Math.min(...[...etapes.values()].map((tours) => tours.size)));
  return out;
}

/** 5b : tours réellement FAITS dans chaque bloc — seules les lignes qui ont commencé comptent. Les blocs de l'it4 rendent 1. */
export function toursParBloc(run: TeamRunView): Map<number, number> {
  return toursDesBlocs(run, aCommence);
}

/**
 * 5b : tours que le PLAN réserve dans chaque bloc, sur toutes les lignes créées au lancement (une par entrée de `planSteps`,
 * chemin maximal). C'est le « Prévu » de l'écart du Déroulé : il est LU, jamais déduit.
 */
export function toursPrevusParBloc(run: TeamRunView): Map<number, number> {
  return toursDesBlocs(run, () => true);
}

/** « étape {n} sur {total} » : n = rang de la dernière étape commencée (1 au moins). */
export function progression(run: TeamRunView): { n: number; total: number; terminees: number } {
  const etapes = etapesVisibles(run);
  // 5b : un spécialiste écarté (« non-choisi ») n'a jamais commencé — il ne fait pas avancer le rang de l'étape courante.
  let n = 0;
  for (const [index, step] of etapes.entries()) if (aCommence(step)) n = index + 1;
  return { n: Math.max(1, n), total: Math.max(1, etapes.length), terminees: etapes.filter((s) => s.state === "terminee").length };
}

/** Plafond d'arrêt retenu au lancement ; à défaut, l'estimation haute. */
const plafondDe = (run: TeamRunView) => run.plafond ?? run.estimate?.maximum ?? 0;

/**
 * Ligne d'une étape : icône + mot, détail « {titre} · {assistant} · {ia} », tentative, troncature et cause.
 * 5b : `tours` = tours réellement faits dans le bloc (toursParBloc) ; il donne « tour {n} » à partir du deuxième et « ×{n} ».
 */
export function ligneEtape(step: StepRunView, advanced: boolean, tours = 1): TeamStepLine {
  const titre = texte(step.titre, TITRE_MAX);
  const nomIa = texte(step.ia.label ?? step.ia.model ?? "", TITRE_MAX);
  // §3.13 l.413 : en Avancé, l'IA choisie par l'équipe est nommée comme telle ; en Simple, celle de l'assistant (décision n° 3).
  const gabaritIa = advanced && step.ia.choisieParEquipe ? TEXTES.avance.iaEtape : TEXTES.simple.iaEtape;
  const ia = nomIa === "" ? "" : remplir(gabaritIa, { ia: nomIa });
  const detail = remplir(P.execution.ligne, { titre, assistant: texte(step.assistantTitre || step.assistant, TITRE_MAX), ia })
    // IA encore inconnue : le séparateur de fin du gabarit est retiré, jamais remplacé par un texte inventé.
    .replace(/ · $/, "");
  return {
    cle: `${step.stepId}-${step.tour}-${step.tentative}`,
    kind: "etape",
    titre,
    detail,
    icone: STEP_ICONS[step.state],
    mot: P.etatsEtape[step.state],
    sessionId: step.sessionId,
    voirTravail: step.sessionId === null ? null : P.boutons.voirTravail,
    tentative: step.tentative > 1 ? remplir(P.execution.tentative, { n: step.tentative }) : null,
    tour: step.tour > 1 ? remplir(C5.relecture.tour, { n: step.tour }) : null,
    verdict: verdictLigne(step.verdict),
    repetition: tours > 1 ? remplir(C5.deroule.repetition, { n: tours }) : null,
    tronquee: step.tronquee ? P.execution.tronquee : null,
    cause: step.cause === null ? null : phraseErreur(step.cause),
  };
}

/** Message d'une pause : la raison du code pour une pause de fraîcheur (D-eq-17), sinon le message du serveur. */
export function messagePause(pause: TeamPauseView, prochaine: string | null): string {
  if (pause.kind === "changement") return pauseChangement(pause.changement?.code ?? "autre");
  const propre = texte(pause.message, MESSAGE_MAX).trim();
  if (propre !== "") return propre;
  switch (pause.kind) {
    case "budget":
      return remplir(P.pauses.budget.message, { titre: prochaine ?? "" }).replace(/«\s*»\s*/, "").trim();
    case "modification":
      return P.pauses.modification.message;
    case "redemarrage-cockpit":
      return P.pauses["redemarrage-cockpit"].message;
    default:
      // Pause de vérification sans message écrit dans l'équipe : le titre de la carte suffit, rien n'est inventé.
      return "";
  }
}

function boutonArreter(): TeamButton {
  return { action: "arreter", libelle: P.boutons.arreter, allure: "danger", desactive: false, raison: null };
}

/**
 * 5b (L42c) : entrée bornée de la carte de choix d'un aiguillage, lue sur la pause. La raison est un texte d'IA : elle est
 * coupée à CHOIX_RAISON_MAX et rendue en texte par React, donc échappée — jamais du HTML.
 */
export function entreeChoix(pause: TeamPauseView): TeamChoixEntree {
  const options = optionsDe(pause.choix).map((option) => ({ ...option, titre: texte(option.titre, TITRE_MAX) }));
  return { options, raison: texte(pause.raison, CHOIX_RAISON_MAX), choixMax: Number(pause.choixMax ?? 1), suiteUsd: pause.suite.typique };
}

/** 5b : carte de choix pour la sélection courante ; `null` = la sélection de départ (les spécialistes proposés cochés). */
export function modeleChoix(entree: TeamChoixEntree, selection: readonly string[] | null): TeamChoiceView {
  return vueChoix({ ...entree, selection: selection ?? selectionInitiale(entree.options, entree.choixMax) });
}

/** Pause : textes, zones modifiables et deux boutons. Le bouton [Continuer] porte les DEUX montants, sauf pour une fraîcheur. */
export function modelePause(run: TeamRunView, pause: TeamPauseView): TeamPauseModel {
  const prochaine = etapesVisibles(run).find((s) => s.state === "prevue" || s.state === "en-file") ?? null;
  const verification = pause.kind === "verification";
  // 5b : une pause de choix a ses propres boutons, dont le libellé suit le nombre de spécialistes cochés (modeleChoix).
  const choix = pause.kind === "choix" ? entreeChoix(pause) : null;
  // « Rien n'est facturé pendant la pause. » : la vérification et le choix d'un aiguillage le disent, les autres l'ont déjà
  // dans leur message.
  const gratuite = P.pauses[pause.kind === "choix" ? "choix" : "verification"].gratuite;
  const libelleContinuer =
    pause.kind === "changement"
      ? P.boutons.continuer
      : remplir(P.boutons.continuerMontants, { suite: pause.suite.typique, auPlus: pause.suite.maximum });
  // <c5:reprise-redemarrage>
  // Pause reprise après un redémarrage (D-5b-1) : [Refaire l'estimation de la suite] prend la place de [Continuer], que le
  // serveur refuserait tant que l'estimation n'est pas refaite ; sans demande reconstituable, seul [Arrêter l'équipe] reste.
  const reprise = modeleReprise(pause);
  const boutonsReprise: TeamButton[] | null =
    reprise === null
      ? null
      : [...(reprise.bouton === null ? [] : [{ action: "relancer" as const, libelle: reprise.bouton, allure: "primary" as const, desactive: false, raison: null }]), boutonArreter()];
  // </c5:reprise-redemarrage>
  return {
    kind: pause.kind,
    choix,
    // <c5:reprise-redemarrage>
    reprise,
    // </c5:reprise-redemarrage>
    titre: P.pauses[pause.kind].titre,
    message: messagePause(pause, prochaine === null ? null : texte(prochaine.titre, TITRE_MAX)),
    resume:
      verification && pause.resultat !== null
        ? {
            entete: remplir(P.pauses.verification.resultat, { titre: texte(pause.resultat.titre, TITRE_MAX) }),
            libelle: P.pauses.verification.resume,
            texte: texte(pause.resultat.texte, FLOW_LIMITS.relaisCaracteres),
            max: FLOW_LIMITS.relaisCaracteres,
          }
        : null,
    precision: verification ? { libelle: P.pauses.verification.precision, aide: P.pauses.verification.precisionAide, max: FLOW_LIMITS.precision } : null,
    gratuite: verification || pause.kind === "choix" ? gratuite : null,
    confirme: pause.kind === "budget",
    // 5b : la carte de choix compose ses trois boutons elle-même (le libellé de [Continuer] suit les cases cochées).
    // <c5:reprise-redemarrage>
    boutons:
      choix !== null
        ? []
        : (boutonsReprise ?? [{ action: "continuer", libelle: libelleContinuer, allure: "primary", desactive: false, raison: null }, boutonArreter()]),
    // </c5:reprise-redemarrage>
  };
}

/** Phrase d'une carte finale (arrêtée, plafond, échec, interrompue, redémarrage du cockpit avant le début). */
export function messageFinal(run: TeamRunView): string {
  const { n } = progression(run);
  const etapes = etapesVisibles(run);
  const echouee = etapes.find((s) => s.state === "echec");
  switch (run.state) {
    case "plafond":
      return remplir(P.cartes.plafond, { depense: run.cost, plafond: plafondDe(run) });
    case "echec":
      return remplir(P.cartes.echec, { titre: echouee === undefined ? "" : texte(echouee.titre, TITRE_MAX) });
    case "interrompue":
      if (run.cause === "redemarrage-cockpit") return run.startedAt === null ? P.cartes.redemarrageAvantDebut : P.cartes.redemarrage;
      return remplir(P.cartes.interrompue, { n });
    default:
      return remplir(P.cartes.arretee, { n });
  }
}

/**
 * Boutons d'une carte finale, selon `relancable` et `resultatsAjoutes` (D-eq-22). `equipesOuvertes` : les équipes sont-elles
 * ouvertes dans le mode courant (toujours en Avancé ; en Simple, `ouvertesEnSimple` de GET /api/teams, U1) ? Fermées, la relance
 * n'est PAS proposée : le serveur refuse `POST …/estimate` et `POST …/relancer` en 403, et une fonction absente ne s'annonce
 * jamais avec un prix (P3, §2.6). L'ouverture tient toujours en une ligne (EQUIPES_SIMPLE_OUVERTES).
 */
export function boutonsFinaux(run: TeamRunView, equipesOuvertes: boolean): TeamButton[] {
  const boutons: TeamButton[] = [];
  if (run.relancable && equipesOuvertes) {
    const suite = run.suite;
    boutons.push({
      action: "relancer",
      // `x` = run.suite.typique : calcul LOCAL, aucune lecture d'opencode avant le clic (D-eq-17).
      libelle: remplir(P.boutons.relancerSuite, { suite: suite === null ? 0 : suite.typique }),
      allure: "primary",
      desactive: suite === null,
      raison: suite === null ? phraseErreur("pas-relancable") : null,
    });
  }
  if (progression(run).terminees > 0) {
    boutons.push({
      action: "ajouter-resultats",
      libelle: P.boutons.ajouterResultats,
      allure: "normal",
      desactive: run.resultatsAjoutes,
      raison: run.resultatsAjoutes ? phraseErreur("deja-ajoute") : null,
    });
  }
  if (ETATS_FERMABLES.has(run.state)) boutons.push({ action: "fermer", libelle: P.boutons.fermer, allure: "normal", desactive: false, raison: null });
  return boutons;
}

/** Résultat d'une équipe terminée : dernière étape terminée qui porte un extrait. */
export function etapeResultat(run: TeamRunView): StepRunView | null {
  return etapesVisibles(run).findLast((s) => s.state === "terminee" && s.extrait !== null) ?? null;
}

/**
 * Le livrable est-il celui d'une RELECTURE ? Même règle que `deliverable()` (flow.ts, `dernierBlocDeTravail`) : seul le DERNIER
 * bloc de travail porte le livrable, et le journal et les notes n'y sont écrits par le cockpit que si ce bloc est une relecture.
 * Lu sur l'état ENREGISTRÉ : le dernier bloc de travail est celui de la dernière ligne d'étape (un bloc « pause » n'en a
 * aucune) ; son genre vient des bornes déclarées du déroulé (`run.blocs`) et, à défaut, de ses lignes — un verdict enregistré
 * ou un tour au-delà du premier ne viennent que d'un bloc « relecture ».
 * Jamais sur le texte du livrable : sans cette porte, une IA qui écrit « ## Journal de relecture » replierait tout ce qui suit
 * dans un `<details>` fermé et signerait une note d'honnêteté à la place du cockpit (P3, §13.2). Clôture 5b (D-5b-2) : la
 * porte regardait la PRÉSENCE d'une relecture dans le déroulé ; une relecture suivie d'une autre étape suffisait alors à
 * rendre le texte de cette étape comme notes du cockpit.
 */
function aRelecture(run: TeamRunView): boolean {
  if (run.steps.length === 0) return false;
  const dernierBloc = Math.max(...run.steps.map((step) => step.blocIndex));
  if (run.blocs !== undefined) return run.blocs.some((bloc) => bloc.type === "relecture" && bloc.index === dernierBloc);
  return run.steps.some((step) => step.blocIndex === dernierBloc && (step.tour > 1 || step.verdict !== undefined));
}

/**
 * Le lancement a-t-il réellement pris le chemin « aucun ne convient » ? Seule VOTRE réponse l'écrit, dans la colonne `choix` de
 * l'aiguilleur (`repondreAuChoix`, D-5-13). Sans cette porte, deux phrases recopiées dans un résultat d'IA suffisaient à poser
 * [Envoyer à cet assistant] vers un assistant que l'IA aurait nommé (P3).
 */
const estAucun = (run: TeamRunView): boolean => run.steps.some((step) => step.choix === "aucun");

/** Carte de résultat (C §9.6) ; `texte` est passé par l'appelant (TeamRunCards ou la transcription, L38c). */
export function modeleResultat(run: TeamRunView, texteResultat: string, advanced: boolean): TeamResultModel {
  const source = etapeResultat(run);
  const { total, terminees } = progression(run);
  const duree = run.endedAt === null || run.startedAt === null ? 0 : Math.max(0, run.endedAt - run.startedAt);
  const nomIa = source === null ? "" : texte(source.ia.label ?? source.ia.model ?? "", TITRE_MAX);
  // 5b : le livrable d'une relecture porte son journal et ses notes ; ils sont DÉCOUPÉS, jamais réécrits, pour que le journal
  // soit replié sous le résultat (C §9.6). Le découpage n'a lieu QUE si le lancement porte une relecture : ailleurs, le
  // livrable est rendu entier, sans repli ni note du cockpit.
  const livrable = texte(texteResultat, FLOW_LIMITS.relaisCaracteres);
  const journal = aRelecture(run) ? journalRelecture(livrable) : { resultat: livrable, titre: null, texte: "", notes: [] };
  return {
    titre: remplir(P.resultat.titre, { equipe: texte(run.titre, TITRE_MAX) }),
    redige: remplir(P.resultat.redige, {
      titre: source === null ? "" : texte(source.titre, TITRE_MAX),
      assistant: source === null ? "" : texte(source.assistantTitre || source.assistant, TITRE_MAX),
      ia: nomIa,
    }),
    iaEquipe: advanced && nomIa !== "" && source?.ia.choisieParEquipe === true ? remplir(TEXTES.avance.iaEtape, { ia: nomIa }) : null,
    resume: resumeResultat(terminees > 0 ? terminees : total, formatDuration(duree), run.cost, run.estimate?.typique ?? 0),
    aVerifier: P.resultat.aVerifier,
    ajouter: P.boutons.ajouter,
    texte: journal.resultat,
    journal: journal.titre === null ? null : { titre: journal.titre, texte: journal.texte },
    notes: journal.notes,
    aucun: estAucun(run) ? aucunDuLivrable(journal.resultat) : null,
  };
}

/** Genre de la carte : une équipe terminée n'est ni une pause, ni une carte finale, ni une exécution en cours. */
function genreCarte(run: TeamRunView, enPause: boolean, finale: boolean): TeamRunCardModel["genre"] {
  if (enPause) return "pause";
  if (finale) return "finale";
  return run.state === "terminee" ? "terminee" : "execution";
}

/** Boutons de la carte : ceux d'une carte finale, ceux de la pause (portés par `modelePause`), l'arrêt, ou aucun. */
function boutonsCarte(run: TeamRunView, etat: { enPause: boolean; finale: boolean; arretable: boolean; equipesOuvertes: boolean }): TeamButton[] {
  if (etat.finale) return boutonsFinaux(run, etat.equipesOuvertes);
  if (etat.enPause) return [];
  return etat.arretable ? [boutonArreter()] : [];
}

/**
 * Modèle complet d'une carte de lancement (exécution, pause, carte finale ou équipe terminée), avec sa carte de résultat s'il y a
 * lieu. `equipesOuvertes` : équipes ouvertes dans le mode courant (défaut : le mode Avancé seulement, U1 ; en Simple, la valeur
 * vient de `ouvertesEnSimple` de GET /api/teams). Fermées, la carte ne propose aucune action que le serveur refuserait.
 */
export function buildTeamRunCard(run: TeamRunView, advanced: boolean, equipesOuvertes: boolean = advanced): TeamRunCardModel {
  const { n, total, terminees } = progression(run);
  const enPause = run.pause !== null && ETATS_ATTENTE.has(run.state);
  const finale = ETATS_FINAUX.has(run.state);
  // L'arrêt n'est proposé que là où il a un sens : POST …/stop répond 409 `etat-incompatible` pour une équipe terminée ou finie.
  const arretable = ETATS_VERROU.has(run.state);
  // 5b : une ligne par TOUR réellement fait, et « ×{n} » sur le bloc qui en a fait plusieurs.
  const tours = toursParBloc(run);
  const lignes = etapesParTour(run).map((step) => ligneEtape(step, advanced, tours.get(step.blocIndex) ?? 1));
  if (run.pause?.kind === "verification") {
    lignes.push({ cle: `pause-${run.id}`, kind: "pause", titre: P.execution.pause, detail: "", icone: "pause", mot: P.execution.pause, sessionId: null, voirTravail: null, tentative: null, tour: null, verdict: null, repetition: null, tronquee: null, cause: null });
  }
  // Une seule carte de résultat (risque 19 : reconnaissance par IDENTIFIANT) : rendue ici seulement quand rien n'a été injecté.
  const resultat = run.state === "terminee" && run.resultMessageId === null ? modeleResultat(run, etapeResultat(run)?.extrait ?? "", advanced) : null;
  return {
    runId: run.id,
    genre: genreCarte(run, enPause, finale),
    entete: remplir(P.execution.entete, { equipe: texte(run.titre, TITRE_MAX), n, total, depense: run.cost, plafond: plafondDe(run) }),
    etatMot: P.etatsEquipe[run.state],
    etatIcone: RUN_ICONS[run.state],
    lignes,
    message: finale ? messageFinal(run) : null,
    bilan: finale ? remplir(P.cartes.bilan, { k: terminees, total, cout: run.cost }) : null,
    pause: enPause && run.pause !== null ? modelePause(run, run.pause) : null,
    boutons: boutonsCarte(run, { enPause, finale, arretable, equipesOuvertes }),
    verrou: ETATS_VERROU.has(run.state) ? P.saisieVerrouillee : null,
    resultat,
    annonce: P.etatsEquipe[run.state],
  };
}

/** Texte de verrou de la conversation : celui de la première équipe qui verrouille (D-eq-16), sinon null. */
export function verrouDe(runs: readonly TeamRunView[]): string | null {
  return runs.some((run) => ETATS_VERROU.has(run.state)) ? P.saisieVerrouillee : null;
}

// --- Relance de la suite (D-eq-17, A4 : estimation d'abord, jamais `relancer` sans empreinte) -----------------------------------

export interface RelanceConfirmation {
  titre: string;
  message: string;
  /** Empreinte de l'estimation ; sans elle, aucun appel à `relancer`. */
  empreinte: string;
}

/** Envoi de la relance : l'empreinte y est toujours, et l'en-tête x-cockpit-confirm: 1 aussi. */
export interface RelanceLancement {
  genre: "relancer";
  empreinte: string;
  confirme: true;
}

export type RelanceEtape = { genre: "estimation" } | { genre: "blocage"; raison: string } | { genre: "confirmation"; confirmation: RelanceConfirmation } | RelanceLancement;

/** Clic sur [Relancer la suite] : une estimation d'abord (POST …/estimate), jamais un lancement. */
export function relanceDebut(run: TeamRunView): RelanceEtape | null {
  return run.relancable ? { genre: "estimation" } : null;
}

/** Réponse de l'estimation : refus prévisible → bouton désactivé avec la raison ; sinon boîte de confirmation. */
export function relanceApresEstimation(reponse: TeamEstimateResponse): RelanceEtape {
  if (reponse.blocage !== null) return { genre: "blocage", raison: phraseBlocage(reponse.blocage.code) };
  const empreinte = typeof reponse.estimateSha256 === "string" ? reponse.estimateSha256 : "";
  if (empreinte === "") return { genre: "blocage", raison: phraseBlocage("estimation-perimee") };
  return {
    genre: "confirmation",
    confirmation: {
      titre: P.relance.titre,
      message: remplir(P.relance.message, { deja: reponse.deja ?? 0, suite: reponse.estimate.typique, plafond: reponse.plafond }),
      empreinte,
    },
  };
}

/** Après la boîte : `relancer` seulement si vous avez confirmé ET que l'empreinte est là. */
export function relanceApresConfirmation(confirmation: RelanceConfirmation | null, accepte: boolean): RelanceLancement | null {
  if (!accepte || confirmation === null || confirmation.empreinte === "") return null;
  return { genre: "relancer", empreinte: confirmation.empreinte, confirme: true };
}

// <c5:reprise-redemarrage>
/**
 * Clôture 5b (D-5b-1) : clic sur [Refaire l'estimation de la suite] d'une pause reprise après un redémarrage. Même suite que la
 * relance (D-eq-17, A4) : une estimation d'abord (POST …/estimate, seules lectures), la boîte ensuite, puis POST …/relancer
 * avec l'empreinte et x-cockpit-confirm: 1 — jamais l'inverse. Rien quand la pause n'attend pas d'estimation ou que la demande
 * n'est plus reconstituable (le serveur refuserait).
 */
export function repriseDebut(run: TeamRunView): RelanceEtape | null {
  return run.pause?.reestimation?.possible === true ? { genre: "estimation" } : null;
}

/**
 * Réponse de l'estimation d'une reprise : refus prévisible → raison ; sinon la boîte « Reprendre avec cette estimation ? », avec
 * les montants de la relance et ce qui suivra VRAIMENT votre confirmation. La pause « Le cockpit a redémarré » repart aussitôt ;
 * toute autre pause revient telle quelle, et rien ne part avant votre réponse (le choix d'un aiguillage reste le vôtre).
 */
export function repriseApresEstimation(pause: TeamPauseView, reponse: TeamEstimateResponse): RelanceEtape {
  const etape = relanceApresEstimation(reponse);
  if (etape.genre !== "confirmation") return etape;
  const suite = pause.kind === "redemarrage-cockpit" ? REPRISE.confirmationReprend : REPRISE.confirmationPause;
  return { genre: "confirmation", confirmation: { ...etape.confirmation, titre: REPRISE.confirmationTitre, message: `${etape.confirmation.message} ${suite}` } };
}
// </c5:reprise-redemarrage>

/**
 * Identifiant du bloc de pause d'un lancement : cible que « [Répondre] » du bandeau peut atteindre, comme
 * `permissionElementId` pour une demande d'autorisation. LE FOCUS N'EST JAMAIS PRIS par la carte elle-même : seul un clic de
 * l'utilisateur l'y amène.
 */
export function teamPauseElementId(runId: string): string {
  return `equipe-pause-${runId}`;
}

/**
 * Préremplissage du composeur par [Envoyer à cet assistant] (chemin « aucun », D-5-13). La carte PUBLIE la demande à
 * recopier et l'assistant de repli, et n'envoie RIEN : aucune requête, aucun coût. Le consommateur est la page du chat, qui
 * remplit la saisie (`Composer.seed`) et choisit l'assistant ; elle est hors du périmètre de ce paquet — `TeamRunCardsProps`
 * est FIGÉ par T4w et `ChatPage.tsx` est de classe A —, d'où la demande de contrat consignée pour l'intégrateur. Tant que
 * personne n'écoute, rien ne se produit au clic : c'est le seul point de ce paquet qui dépende d'un câblage à venir.
 */
export const EVENEMENT_COMPOSEUR = "cockpit:composeur-prerempli";

/** Charge utile de EVENEMENT_COMPOSEUR : la demande à recopier (message injecté au lancement) et l'assistant de repli. */
export interface ComposeurPrerempli {
  assistant: string;
  rootId: string;
  runId: string;
  /** Message de la demande recopiée par le lancement (`TeamRunView.requestMessageId`) ; null s'il n'a pas été injecté. */
  demandeMessageId: string | null;
}

/** Boîte « Arrêter l'équipe ? » (C §9.5). */
export function confirmationArret(): { titre: string; message: string; confirmer: string; annuler: string } {
  return { titre: P.arret.titre, message: P.arret.message, confirmer: P.arret.confirmer, annuler: P.arret.annuler };
}
