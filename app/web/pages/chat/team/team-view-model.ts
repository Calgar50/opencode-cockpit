// Propriétaire : L38b.
// Modèle PUR des cartes d'équipe du chat (D-eq-24 : toute la logique ici, les .tsx restent minces) : TeamRunView → genre de carte,
// en-tête, lignes d'étapes (icône ET mot, jamais la couleur seule, §2.3 l.107-117), textes de pause, boutons, texte de verrou
// (D-eq-16) et présence de la carte de résultat (`resultMessageId === null`). Spécification §5.1 l.876-881, §7.8 l.1184, §3.12
// l.392 ; C §9.5, §9.6 ; plan it4 §6 fiche L38b, §4.1.1.
// Aucun texte écrit ici : tout vient de server/shared/team-texts.ts (T4t). Montants écrits par montant() ou par remplir() avec un
// nombre, JAMAIS par formatUsd(), qui ajoute déjà « $ » (report MX-EQ au train de V0, §4.2).
// Relance (D-eq-17, A4) : estimation d'abord au clic, confirmation ensuite, `relancer` jamais sans empreinte.
// Testé par server/web-team-cards.test.ts ; aucun composant (.tsx) importé, aucun appel réseau.
import { FLOW_LIMITS } from "../../../../server/shared/team-limits.ts";
import { pauseChangement, phraseBlocage, phraseErreur, remplir, resumeResultat, TEXTES } from "../../../../server/shared/team-texts.ts";
import type { StepRunView, TeamEstimateResponse, TeamPauseView, TeamRunState, TeamRunView, TeamStepState } from "../../../../server/shared/team-types.ts";
import { formatDuration } from "../../../lib/format.ts";
import { boundedAiText } from "../turn.ts";

const P = TEXTES.partout;

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
};

/** Icône de chaque état de lancement (TeamRunState). */
export const RUN_ICONS: Readonly<Record<TeamRunState, TeamIconName>> = {
  preparation: "circle",
  "en-cours": "pulse",
  "attente-verification": "pause",
  "attente-budget": "coins",
  "attente-modification": "alert",
  terminee: "check",
  arretee: "stop",
  echec: "x",
  interrompue: "plug",
  plafond: "gauge",
};

/** États qui verrouillent la saisie (D-eq-16) : `interrompue`, `plafond`, `echec` et `terminee` ne verrouillent PAS. */
export const ETATS_VERROU: ReadonlySet<TeamRunState> = new Set<TeamRunState>(["preparation", "en-cours", "attente-verification", "attente-budget", "attente-modification"]);

/** Cartes finales (D-eq-22 : [Ajouter les résultats obtenus à la conversation] y est proposé). */
export const ETATS_FINAUX: ReadonlySet<TeamRunState> = new Set<TeamRunState>(["arretee", "plafond", "echec", "interrompue"]);

/** Attentes : la carte montre alors la pause, jamais l'en-tête d'exécution. */
export const ETATS_ATTENTE: ReadonlySet<TeamRunState> = new Set<TeamRunState>(["attente-verification", "attente-budget", "attente-modification"]);

/** États dont POST …/fermer fait une équipe `arretee` (plan §4.1.5) ; `arretee` n'a plus rien à fermer. */
const ETATS_FERMABLES: ReadonlySet<TeamRunState> = new Set<TeamRunState>(["interrompue", "plafond", "echec"]);

/** Titre d'équipe, titre d'étape et message de pause : écrits par vous ou par un exemple, montrés en texte, bornés. */
const TITRE_MAX = 120;
const MESSAGE_MAX = 600;

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
  /** « Réponse peut-être incomplète… » quand l'étape a atteint sa limite d'actions. */
  tronquee: string | null;
  /** Phrase de la cause d'un échec ou d'un arrêt ; null sans cause. */
  cause: string | null;
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
}

export interface TeamRunCardModel {
  runId: string;
  genre: "execution" | "pause" | "finale";
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

/** « étape {n} sur {total} » : n = rang de la dernière étape commencée (1 au moins). */
export function progression(run: TeamRunView): { n: number; total: number; terminees: number } {
  const etapes = etapesVisibles(run);
  const commencee = (s: StepRunView) => s.state !== "prevue" && s.state !== "non-lancee";
  let n = 0;
  for (const [index, step] of etapes.entries()) if (commencee(step)) n = index + 1;
  return { n: Math.max(1, n), total: Math.max(1, etapes.length), terminees: etapes.filter((s) => s.state === "terminee").length };
}

/** Plafond d'arrêt retenu au lancement ; à défaut, l'estimation haute. */
const plafondDe = (run: TeamRunView) => run.plafond ?? run.estimate?.maximum ?? 0;

/** Ligne d'une étape : icône + mot, détail « {titre} · {assistant} · {ia} », tentative, troncature et cause. */
export function ligneEtape(step: StepRunView, advanced: boolean): TeamStepLine {
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

/** Pause : textes, zones modifiables et deux boutons. Le bouton [Continuer] porte les DEUX montants, sauf pour une fraîcheur. */
export function modelePause(run: TeamRunView, pause: TeamPauseView): TeamPauseModel {
  const prochaine = etapesVisibles(run).find((s) => s.state === "prevue" || s.state === "en-file") ?? null;
  const verification = pause.kind === "verification";
  const libelleContinuer =
    pause.kind === "changement"
      ? P.boutons.continuer
      : remplir(P.boutons.continuerMontants, { suite: pause.suite.typique, auPlus: pause.suite.maximum });
  return {
    kind: pause.kind,
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
    gratuite: pause.kind === "verification" ? P.pauses.verification.gratuite : null,
    confirme: pause.kind === "budget",
    boutons: [{ action: "continuer", libelle: libelleContinuer, allure: "primary", desactive: false, raison: null }, boutonArreter()],
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

/** Boutons d'une carte finale, selon `relancable` et `resultatsAjoutes` (D-eq-22). */
export function boutonsFinaux(run: TeamRunView): TeamButton[] {
  const boutons: TeamButton[] = [];
  if (run.relancable) {
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

/** Carte de résultat (C §9.6) ; `texte` est passé par l'appelant (TeamRunCards ou la transcription, L38c). */
export function modeleResultat(run: TeamRunView, texteResultat: string, advanced: boolean): TeamResultModel {
  const source = etapeResultat(run);
  const { total, terminees } = progression(run);
  const duree = run.endedAt === null || run.startedAt === null ? 0 : Math.max(0, run.endedAt - run.startedAt);
  const nomIa = source === null ? "" : texte(source.ia.label ?? source.ia.model ?? "", TITRE_MAX);
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
    texte: texte(texteResultat, FLOW_LIMITS.relaisCaracteres),
  };
}

/** Modèle complet d'une carte de lancement (exécution, pause ou carte finale), avec sa carte de résultat s'il y a lieu. */
export function buildTeamRunCard(run: TeamRunView, advanced: boolean): TeamRunCardModel {
  const etapes = etapesVisibles(run);
  const { n, total, terminees } = progression(run);
  const enPause = run.pause !== null && ETATS_ATTENTE.has(run.state);
  const finale = ETATS_FINAUX.has(run.state);
  const lignes = etapes.map((step) => ligneEtape(step, advanced));
  if (run.pause?.kind === "verification") {
    lignes.push({ cle: `pause-${run.id}`, kind: "pause", titre: P.execution.pause, detail: "", icone: "pause", mot: P.execution.pause, sessionId: null, voirTravail: null, tentative: null, tronquee: null, cause: null });
  }
  // Une seule carte de résultat (risque 19 : reconnaissance par IDENTIFIANT) : rendue ici seulement quand rien n'a été injecté.
  const resultat = run.state === "terminee" && run.resultMessageId === null ? modeleResultat(run, etapeResultat(run)?.extrait ?? "", advanced) : null;
  return {
    runId: run.id,
    genre: enPause ? "pause" : finale ? "finale" : "execution",
    entete: remplir(P.execution.entete, { equipe: texte(run.titre, TITRE_MAX), n, total, depense: run.cost, plafond: plafondDe(run) }),
    etatMot: P.etatsEquipe[run.state],
    etatIcone: RUN_ICONS[run.state],
    lignes,
    message: finale ? messageFinal(run) : null,
    bilan: finale ? remplir(P.cartes.bilan, { k: terminees, total, cout: run.cost }) : null,
    pause: enPause && run.pause !== null ? modelePause(run, run.pause) : null,
    boutons: finale ? boutonsFinaux(run) : enPause ? [] : [boutonArreter()],
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

/** Boîte « Arrêter l'équipe ? » (C §9.5). */
export function confirmationArret(): { titre: string; message: string; confirmer: string; annuler: string } {
  return { titre: P.arret.titre, message: P.arret.message, confirmer: P.arret.confirmer, annuler: P.arret.annuler };
}
