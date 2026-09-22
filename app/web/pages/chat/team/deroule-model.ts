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
// Aucun texte écrit ici : tout vient de server/shared/team-texts.ts (T4t). Montants par montant(), jamais par formatUsd() (report
// MX-EQ §4.2). Testé par server/web-team-deroule.test.ts ; aucun composant importé, aucun appel réseau.
import { montant, remplir, TEXTES } from "../../../../server/shared/team-texts.ts";
import type { StepRunView, TeamRunView } from "../../../../server/shared/team-types.ts";
import { boundedAiText } from "../turn.ts";
import { etapesVisibles, progression, type TeamIconName, RUN_ICONS, STEP_ICONS } from "./team-view-model.ts";

const P = TEXTES.partout;

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

/** Ligne d'une étape : prévu, réel, tentative, durée, coût et sa barre. */
export function ligneDeroule(step: StepRunView, fenetre: { from: number; to: number }, now: number, advanced: boolean): TeamDerouleRow {
  const titre = texte(step.titre, TITRE_MAX);
  const nomIa = texte(step.ia.label ?? step.ia.model ?? "", TITRE_MAX);
  const gabaritIa = advanced && step.ia.choisieParEquipe ? TEXTES.avance.iaEtape : TEXTES.simple.iaEtape;
  const ia = nomIa === "" ? "" : remplir(gabaritIa, { ia: nomIa });
  const detail = remplir(P.execution.ligne, { titre, assistant: texte(step.assistantTitre || step.assistant, TITRE_MAX), ia }).replace(/ · $/, "");
  const fin = finEtape(step, now);
  const bar = step.startedAt === null ? null : barre(genreEtape(step), step.startedAt, fin, fenetre);
  return {
    cle: `${step.stepId}-${step.tour}-${step.tentative}`,
    kind: "etape",
    titre,
    detail,
    prevu: true,
    reel: P.etatsEtape[step.state],
    icone: STEP_ICONS[step.state],
    tentative: step.tentative > 1 ? remplir(P.execution.tentative, { n: step.tentative }) : null,
    start: step.startedAt,
    durationMs: step.startedAt === null ? null : Math.max(0, fin - step.startedAt),
    cost: step.cost,
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
    start: debut,
    durationMs: Math.max(0, now - debut),
    cost: 0,
    bars: bar === null ? [] : [bar],
  };
}

/** Déroulé d'un lancement : une ligne par étape (dernière tentative), puis la pause en cours s'il y en a une. */
export function buildTeamDeroule(run: TeamRunView, advanced: boolean, now: number): TeamDerouleModel {
  const fenetre = fenetreDe(run, now);
  const { total, terminees } = progression(run);
  const lignes = etapesVisibles(run).map((step) => ligneDeroule(step, fenetre, now, advanced));
  const pause = lignePause(run, fenetre, now);
  if (pause !== null) lignes.push(pause);
  return {
    runId: run.id,
    titre: `${P.equipe} « ${texte(run.titre, TITRE_MAX)} »`,
    etatMot: P.etatsEquipe[run.state],
    etatIcone: RUN_ICONS[run.state],
    bilan: remplir(P.cartes.bilan, { k: terminees, total, cout: run.cost }),
    lignes,
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
