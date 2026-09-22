// Propriétaire : L38c.
// Modèle PUR du « Prévu / Réel » des équipes, en tête du Déroulé (panneau de contexte et Archives ; spécification §5.1 l.878-883,
// §5.5 ; C §9.14 ; D-eq-24 : toute la logique ici, le .tsx reste mince).
// Une ligne par étape (dernière tentative, comme les cartes de L38b) et, quand l'équipe attend, une ligne pour la pause :
// - PRÉVU : l'étape ou la pause vient du déroulé de l'équipe (vrai partout, sauf pour une pause que l'équipe n'a pas prévue :
//   garde-fou budgétaire, assistant modifié, redémarrage du cockpit, situation changée depuis l'estimation) ;
// - RÉEL : le mot de l'état (team-texts.ts), plus « tentative {n} » à partir de la deuxième ;
// - BARRES : « génération » pendant le travail d'une étape, « attente de vous » quand l'étape attend votre accord ou quand
//   l'équipe attend votre choix, « pause » (mot « vérification ») pendant une pause pour vérifier.
// Tout vient des données du cockpit (SQLite, GET /api/team-runs) : AUCUNE requête à opencode (A4), aucune horloge lue ici (`now`
// est passé par l'appelant, qui le fige pour tout le Déroulé).
// HONNÊTETÉ : une étape sans début (`startedAt === null`) n'a AUCUNE barre — le cockpit ne dessine jamais un temps qu'il n'a pas
// enregistré ; une étape en attente de votre accord n'a qu'une barre, celle de l'état courant, faute d'avoir enregistré l'instant
// du basculement (aucun découpage inventé).
// Aucun texte écrit ici : tout vient de server/shared/team-texts.ts (T4t) et, pour la 5b, de
// server/shared/construction-texts.ts. Montants par montant(), jamais par formatUsd() (report MX-EQ §4.2).
// 5b (L42c) : une ligne par TOUR réellement fait d'une relecture, « ×{n} » sur le bloc, le verdict en MOT et icône,
// « Non relue après la dernière correction. » quand la dernière correction n'a pas été relue ; pour un aiguillage, les
// spécialistes retenus et les autres « Non choisi » (icône `minus`, AUCUNE barre, AUCUN coût) ; et, EN GRAS, l'écart entre le
// prévu et le réel (ecartTours, ecartSpecialistes). Tout vient des lignes enregistrées par le cockpit : rien n'est supposé.
// Testé par server/web-team-deroule.test.ts (it4) et server/team-deroule-c5.test.ts (5b) ; aucun composant importé, aucun appel
// réseau.
import { ecartSpecialistes, ecartTours, TEXTES as CONSTRUCTION } from "../../../../server/shared/construction-texts.ts";
import { montant, remplir, TEXTES } from "../../../../server/shared/team-texts.ts";
import type { StepRunView, TeamRunView } from "../../../../server/shared/team-types.ts";
import { boundedAiText } from "../turn.ts";
import { etapesParTour, progression, type TeamIconName, RUN_ICONS, STEP_ICONS, toursParBloc, toursPrevusParBloc, verdictLigne } from "./team-view-model.ts";

const P = TEXTES.partout;
/** Phrases de la construction (5b) : « tour {n} », verdicts, « ×{n} » et « Non relue après la dernière correction. ». */
const C5 = CONSTRUCTION.partout.execution;

/** Titre d'équipe et titre d'étape : écrits par vous ou par un exemple, montrés en texte, bornés (mêmes bornes que L38b). */
const TITRE_MAX = 120;

const texte = (valeur: unknown, max: number) => boundedAiText(valeur, max).text;

/**
 * Genres de barre du Déroulé des équipes. « generation » et « attente-vous » reprennent les classes de `deroule.css` (it1), qui
 * portent déjà leur bloc `forced-colors` ; « verification » est la barre neuve de `team-deroule.css`.
 */
export type TeamBarKind = "generation" | "attente-vous" | "verification";

export interface TeamDerouleBar {
  kind: TeamBarKind;
  /** Position et largeur en pourcentage de la durée montrée (0 à 100). */
  left: number;
  width: number;
  durationMs: number;
}

export interface TeamDerouleRow {
  /** Clé de rendu : étape, tour et tentative, ou la pause du lancement. */
  cle: string;
  kind: "etape" | "pause";
  titre: string;
  /** « {titre} · {assistant} · {ia} » pour une étape ; vide pour la ligne de pause. */
  detail: string;
  /** Prévu par le déroulé de l'équipe (✓) ; faux pour une pause que l'équipe n'a pas prévue. */
  prevu: boolean;
  /** Réel : le mot de l'état, lu à côté de l'icône (jamais la couleur seule, §2.3 l.107-117). */
  reel: string;
  icone: TeamIconName;
  /** « tentative {n} » à partir de la deuxième ; null sinon. */
  tentative: string | null;
  /** 5b : « tour {n} » à partir du deuxième tour d'une relecture ; null ailleurs. */
  tour: string | null;
  /** 5b : verdict d'une relecture, en MOT et icône ; null hors d'une étape de relecture. */
  verdict: { mot: string; icone: TeamIconName } | null;
  /** 5b : « ×{n} » porté par la PREMIÈRE ligne d'un bloc qui a travaillé plusieurs tours ; null ailleurs. */
  repetition: string | null;
  /** Début enregistré ; null : rien n'a commencé (aucune barre non plus). */
  start: number | null;
  /** Durée enregistrée ; null quand rien n'a commencé. */
  durationMs: number | null;
  cost: number;
  bars: TeamDerouleBar[];
}

export interface TeamDerouleModel {
  runId: string;
  /** « Équipe « {titre} » ». */
  titre: string;
  /** Mot de l'état du lancement, et son icône. */
  etatMot: string;
  etatIcone: TeamIconName;
  /** « Étapes terminées : {k} sur {total} · {cout} $ ». */
  bilan: string;
  lignes: TeamDerouleRow[];
  /**
   * 5b : écart entre le PRÉVU et le RÉEL, une phrase par bloc répétable, montrée EN GRAS (§5.1 l.881) :
   * « Prévu : jusqu'à {n} tours · Réel : {m} tour(s) » et « Prévu : jusqu'à {n} spécialistes · Réel : {m} ». Vide quand le
   * déroulé n'a ni relecture ni aiguillage — il n'y a alors aucun écart à montrer.
   */
  ecarts: string[];
  /** 5b : notes d'honnêteté du déroulé (« Non relue après la dernière correction. »). */
  notes: string[];
}

/** Pauses que le déroulé de l'équipe a prévues : seule la pause pour vérifier en est une (les autres sont des incidents). */
const PAUSES_PREVUES: ReadonlySet<string> = new Set(["verification"]);

/** Fin d'une étape : l'instant enregistré, sinon `now` tant qu'elle n'a pas fini. */
const finEtape = (step: StepRunView, now: number) => step.endedAt ?? now;

/** Genre de barre d'une étape : l'attente de votre accord se lit « vous », le reste est du travail. */
const genreEtape = (step: StepRunView): TeamBarKind => (step.state === "attente-accord" ? "attente-vous" : "generation");

/** Genre de barre d'une pause : « vérification » pour la pause prévue, « vous » pour les attentes d'un incident. */
const genrePause = (kind: string): TeamBarKind => (kind === "verification" ? "verification" : "attente-vous");

/** Début d'une pause : la fin de la dernière étape qui a fini ; à défaut, le début du lancement. */
export function debutPause(run: TeamRunView, depart: number): number {
  const fins = run.steps.map((step) => step.endedAt).filter((at): at is number => typeof at === "number");
  return fins.length === 0 ? depart : Math.max(depart, Math.max(...fins));
}

/** Fenêtre montrée : du début du lancement (ou de sa création) à sa fin, ou à `now` tant qu'il n'a pas fini. */
export function fenetreDe(run: TeamRunView, now: number): { from: number; to: number } {
  const from = run.startedAt ?? run.createdAt;
  const ends = [run.endedAt ?? now, ...run.steps.map((step) => finEtape(step, now))];
  return { from, to: Math.max(from + 1, ...ends) };
}

/** Barre d'un intervalle, coupée à la fenêtre ; null quand l'intervalle est vide ou hors fenêtre. */
function barre(kind: TeamBarKind, start: number, end: number, fenetre: { from: number; to: number }): TeamDerouleBar | null {
  const a = Math.max(start, fenetre.from);
  const b = Math.min(end, fenetre.to);
  if (b <= a) return null;
  const span = fenetre.to - fenetre.from;
  return { kind, left: ((a - fenetre.from) / span) * 100, width: Math.max(0.5, ((b - a) / span) * 100), durationMs: b - a };
}

/**
 * Ligne d'une étape : prévu, réel, tentative, durée, coût et sa barre.
 * 5b : `tours` = tours réellement faits dans le bloc, et `premiere` dit si c'est la première ligne du bloc — « ×{n} » s'écrit
 * là, sur le bloc, jamais sur chaque ligne.
 */
export function ligneDeroule(
  step: StepRunView,
  fenetre: { from: number; to: number },
  now: number,
  advanced: boolean,
  bloc: { tours?: number; premiere?: boolean } = {},
): TeamDerouleRow {
  const titre = texte(step.titre, TITRE_MAX);
  const nomIa = texte(step.ia.label ?? step.ia.model ?? "", TITRE_MAX);
  const gabaritIa = advanced && step.ia.choisieParEquipe ? TEXTES.avance.iaEtape : TEXTES.simple.iaEtape;
  const ia = nomIa === "" ? "" : remplir(gabaritIa, { ia: nomIa });
  const detail = remplir(P.execution.ligne, { titre, assistant: texte(step.assistantTitre || step.assistant, TITRE_MAX), ia }).replace(/ · $/, "");
  const fin = finEtape(step, now);
  // 5b : un spécialiste écarté n'a rien envoyé — AUCUNE barre, AUCUN coût, quoi qu'il y ait dans la ligne enregistrée.
  const ecarte = step.state === "non-choisi";
  const bar = step.startedAt === null || ecarte ? null : barre(genreEtape(step), step.startedAt, fin, fenetre);
  const tours = bloc.tours ?? 1;
  return {
    cle: `${step.stepId}-${step.tour}-${step.tentative}`,
    kind: "etape",
    titre,
    detail,
    prevu: true,
    reel: P.etatsEtape[step.state],
    icone: STEP_ICONS[step.state],
    tentative: step.tentative > 1 ? remplir(P.execution.tentative, { n: step.tentative }) : null,
    tour: step.tour > 1 ? remplir(C5.relecture.tour, { n: step.tour }) : null,
    verdict: verdictLigne(step.verdict),
    repetition: tours > 1 && bloc.premiere === true ? remplir(C5.deroule.repetition, { n: tours }) : null,
    start: ecarte ? null : step.startedAt,
    durationMs: step.startedAt === null || ecarte ? null : Math.max(0, fin - step.startedAt),
    cost: ecarte ? 0 : step.cost,
    bars: bar === null ? [] : [bar],
  };
}

/** Ligne de la pause en cours ; null quand l'équipe n'attend pas. */
export function lignePause(run: TeamRunView, fenetre: { from: number; to: number }, now: number): TeamDerouleRow | null {
  const pause = run.pause;
  if (pause === null) return null;
  const debut = debutPause(run, fenetre.from);
  const bar = barre(genrePause(pause.kind), debut, now, fenetre);
  return {
    cle: `pause-${run.id}`,
    kind: "pause",
    titre: P.pauses[pause.kind].titre,
    detail: "",
    prevu: PAUSES_PREVUES.has(pause.kind),
    reel: P.etatsEquipe[run.state],
    icone: RUN_ICONS[run.state],
    tentative: null,
    tour: null,
    verdict: null,
    repetition: null,
    start: debut,
    durationMs: Math.max(0, now - debut),
    cost: 0,
    bars: bar === null ? [] : [bar],
  };
}

// --- Écarts « Prévu / Réel » des formes de la 5b --------------------------------------------------------------------------

/** Lignes d'un bloc, dans l'ordre du plan. */
const lignesDuBloc = (run: TeamRunView, blocIndex: number) => run.steps.filter((step) => step.blocIndex === blocIndex).sort((a, b) => a.ordre - b.ordre);

/** Bloc répété : une relecture est la seule forme dont le plan réserve plusieurs tours à une même étape. */
const estRelecture = (lignes: readonly StepRunView[]) => lignes.some((step) => step.tour > 1);

/** Bloc d'aiguillage : une étape y porte un choix, ou une étape y a été écartée par votre choix. */
const estAiguillage = (lignes: readonly StepRunView[]) => lignes.some((step) => step.choix !== undefined && step.choix !== null) || lignes.some((step) => step.state === "non-choisi");

/**
 * Spécialistes d'un aiguillage : les lignes du bloc, moins l'aiguilleur (la première du plan) et moins la synthèse (la
 * dernière, que le plan n'ajoute qu'à partir de deux spécialistes possibles, C §6.2). « Prévu » est leur nombre, « réel » celui
 * des spécialistes que votre choix a retenus.
 */
export function specialistesDuBloc(lignes: readonly StepRunView[]): { prevu: number; reel: number } {
  const candidats = lignes.slice(1);
  const specialistes = candidats.length >= 2 ? candidats.slice(0, -1) : candidats;
  return { prevu: specialistes.length, reel: specialistes.filter((step) => step.state !== "non-choisi").length };
}

/**
 * Écarts et notes d'un lancement. Un écart n'est écrit que pour un bloc répétable : sans relecture ni aiguillage, le Déroulé de
 * l'itération 4 ne change en rien.
 */
export function ecartsDe(run: TeamRunView): { ecarts: string[]; notes: string[] } {
  const faits = toursParBloc(run);
  const prevus = toursPrevusParBloc(run);
  const ecarts: string[] = [];
  const notes: string[] = [];
  for (const blocIndex of [...new Set(run.steps.map((step) => step.blocIndex))].sort((a, b) => a - b)) {
    const lignes = lignesDuBloc(run, blocIndex);
    if (estRelecture(lignes)) {
      ecarts.push(ecartTours(prevus.get(blocIndex) ?? 1, faits.get(blocIndex) ?? 0));
      // Dernière correction jamais relue : l'auteur a écrit un tour de plus que le relecteur n'en a relu (C §6.2).
      const parEtape = new Map<string, number>();
      for (const step of lignes) if (aCommenceLigne(step)) parEtape.set(step.stepId, Math.max(parEtape.get(step.stepId) ?? 0, step.tour));
      const tours = [...parEtape.values()];
      if (tours.length >= 2 && Math.max(...tours) > Math.min(...tours)) notes.push(C5.relecture.nonRelue);
    } else if (estAiguillage(lignes)) {
      const { prevu, reel } = specialistesDuBloc(lignes);
      ecarts.push(ecartSpecialistes(prevu, reel));
    }
  }
  return { ecarts, notes };
}

/** Une ligne a-t-elle commencé ? Même règle que les cartes : l'état seul le dit (aucun tour supposé). */
const aCommenceLigne = (step: StepRunView): boolean => step.state !== "prevue" && step.state !== "non-lancee" && step.state !== "non-choisi";

/** Déroulé d'un lancement : une ligne par étape (dernière tentative), puis la pause en cours s'il y en a une. */
export function buildTeamDeroule(run: TeamRunView, advanced: boolean, now: number): TeamDerouleModel {
  const fenetre = fenetreDe(run, now);
  const { total, terminees } = progression(run);
  const tours = toursParBloc(run);
  const vus = new Set<number>();
  const lignes = etapesParTour(run).map((step) => {
    const premiere = !vus.has(step.blocIndex);
    vus.add(step.blocIndex);
    return ligneDeroule(step, fenetre, now, advanced, { tours: tours.get(step.blocIndex) ?? 1, premiere });
  });
  const pause = lignePause(run, fenetre, now);
  if (pause !== null) lignes.push(pause);
  const { ecarts, notes } = ecartsDe(run);
  return {
    runId: run.id,
    titre: `${P.equipe} « ${texte(run.titre, TITRE_MAX)} »`,
    etatMot: P.etatsEquipe[run.state],
    etatIcone: RUN_ICONS[run.state],
    bilan: remplir(P.cartes.bilan, { k: terminees, total, cout: run.cost }),
    lignes,
    ecarts,
    notes,
  };
}

/** Déroulés de tous les lancements de la conversation, du plus ancien au plus récent. */
export function buildTeamDeroules(runs: readonly TeamRunView[], advanced: boolean, now: number): TeamDerouleModel[] {
  return [...runs].sort((a, b) => a.createdAt - b.createdAt).map((run) => buildTeamDeroule(run, advanced, now));
}

/** Montant d'une cellule de coût : « 0,60 $ » (montant() puis le symbole du gabarit, jamais formatUsd). */
export function coutCellule(usd: number): string {
  return `${montant(usd)} $`;
}
