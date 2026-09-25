// Propriétaire : L42c.
// Modèle PUR de la carte de choix d'un aiguillage (5b ; spécification §2.3, §5.1 ; C §9.5, §9.6 ; plan d'exécution it5 §4.3,
// fiche L42c) : validité du choix, compte des spécialistes retenus, libellé du bouton [Continuer …], chemin « aucun » et
// journal de relecture d'un livrable.
// AUCUN texte n'est écrit ici : toutes les phrases viennent de ./construction-texts.ts (T5a), remplies par gabarit « {nom} ».
// Les montants passent par montant() de ./team-texts.ts, jamais par formatUsd() (report MX-EQ).
// HONNÊTETÉ : rien n'est supposé de l'aiguilleur. Un choix illisible ne coche RIEN et le dit ; une raison absente n'est pas
// remplacée par une phrase inventée ; le bouton ne propose jamais un nombre de spécialistes que le serveur refuserait
// (1 à `choixMax`, tous pris dans la liste fermée de la pause).
// Texte d'IA : ce module ne borne ni n'assainit (il n'a pas accès à boundedAiText, qui vit dans l'interface) ; l'appelant lui
// passe des textes DÉJÀ bornés (team-view-model.ts : `texte(pause.raison, CHOIX_RAISON_MAX)`), et React les rend en texte,
// donc échappés.
// Testé par server/team-choice-view.test.ts ; aucun import hors de ./ (règle de pureté de core.test.ts).
import { TEXTES as CONSTRUCTION } from "./construction-texts.ts";
import { montant, remplir } from "./team-texts.ts";

const E = CONSTRUCTION.partout.execution;

/** Raison de l'aiguilleur montrée au plus (texte d'IA, borné par l'appelant avant d'arriver ici). */
export const CHOIX_RAISON_MAX = 300;

/** Titre d'un spécialiste montré au plus (écrit par vous ou par un exemple) : même borne que les cartes de L38b. */
export const CHOIX_TITRE_MAX = 120;

/** Séparateur des titres énumérés dans la phrase de proposition. */
const SEPARATEUR = ", ";

/** Un spécialiste soumis à votre confirmation (TeamPauseView.choix). */
export interface ChoixPropose {
  stepId: string;
  titre: string;
  /** L'aiguilleur l'a proposé : faux PARTOUT quand son choix est illisible (rien n'est présélectionné). */
  propose: boolean;
}

/** Une case de la carte de choix. */
export interface ChoixCase {
  stepId: string;
  titre: string;
  coche: boolean;
}

/** Carte de choix complète (C §9.5). */
export interface TeamChoiceView {
  titre: string;
  /**
   * « L'aiguilleur propose « {choix} » : « {raison} ». C'est la proposition d'une IA : vérifiez-la. » ; null quand le choix est
   * illisible, et null aussi quand l'aiguilleur n'a donné AUCUNE raison lisible — le cockpit n'écrit pas de phrase à sa place.
   */
  proposition: string | null;
  /** « L'aiguilleur n'a pas donné de choix lisible : choisissez vous-même. » ; null quand le choix est lisible. */
  illisible: string | null;
  cases: ChoixCase[];
  /** « {n} au maximum. » */
  maximum: string;
  choixMax: number;
  /** Libellé de [Continuer avec {n} spécialiste(s) (≈ {x} $)] : le coût de la SUITE, jamais le total déjà dépensé. */
  continuer: string;
  /** Le bouton [Continuer] est-il utilisable ? Faux tant que la sélection n'est pas valide (le serveur la refuserait). */
  continuerActif: boolean;
  aucunConvient: string;
  arreter: string;
}

/**
 * Chemin « aucun » (D-5-13), LU SUR LE LIVRABLE : c'est le seul endroit où le NOM de l'assistant de repli arrive jusqu'à
 * l'interface. Ni `TeamPauseView` ni `StepRunView` ne portent ce nom (types de L42a) ; `deliverable()` de ./flow.ts est le seul
 * producteur, et il écrit les deux phrases de `execution.aucun`. Les phrases elles-mêmes restent dans le livrable, rendu tel
 * quel : la carte n'ajoute que le bouton.
 * L'ÉTAT « aucun », lui, est bien enregistré (`StepRunView.choix === "aucun"`, écrit par votre seule réponse) : l'appelant le
 * vérifie AVANT d'appeler ce module (team-view-model.ts, `modeleResultat`). Sans cette porte, un résultat d'IA qui recopie les
 * deux phrases ferait apparaître un bouton vers un assistant nommé par l'IA.
 */
export interface TeamAucunView {
  /** Assistant de repli nommé par le livrable ; null quand l'aiguillage n'en propose aucun. */
  assistant: string | null;
  /** Libellé de [Envoyer à cet assistant] ; null sans repli connu : aucun bouton vers un assistant que le cockpit ignore (P3). */
  envoyer: string | null;
}

/** Texte utile d'une valeur venue du serveur ou d'une IA : une chaîne, sans espaces de bord ; sinon la chaîne vide. */
function propre(valeur: unknown): string {
  return typeof valeur === "string" ? valeur.trim() : "";
}

/** Liste fermée des spécialistes soumis à votre confirmation : seules les entrées complètes comptent. */
export function optionsDe(choix: readonly ChoixPropose[] | undefined): ChoixPropose[] {
  if (!Array.isArray(choix)) return [];
  const vues = new Set<string>();
  const out: ChoixPropose[] = [];
  for (const option of choix) {
    const stepId = propre(option?.stepId);
    if (stepId === "" || vues.has(stepId)) continue;
    vues.add(stepId);
    out.push({ stepId, titre: propre(option?.titre), propose: option?.propose === true });
  }
  return out;
}

/**
 * Choix lisible : l'aiguilleur a proposé au moins un spécialiste de la liste. Sinon rien n'est coché et la carte le dit — le
 * cockpit ne coche jamais une case « par défaut » à la place d'une IA qu'il n'a pas comprise.
 */
export function choixLisible(options: readonly ChoixPropose[]): boolean {
  return options.some((option) => option.propose);
}

/** Spécialistes retenus au plus : `choixMax` de la pause, borné par la liste et jamais inférieur à 1. */
export function bornerChoixMax(choixMax: unknown, nombreOptions: number): number {
  const brut = Math.trunc(Number(choixMax));
  const borne = Number.isFinite(brut) && brut >= 1 ? brut : 1;
  return Math.max(1, Math.min(borne, Math.max(1, nombreOptions)));
}

/** Sélection de départ : les spécialistes proposés, dans l'ordre du déroulé ; rien quand le choix est illisible. */
export function selectionInitiale(options: readonly ChoixPropose[], choixMax: number): string[] {
  if (!choixLisible(options)) return [];
  return options
    .filter((option) => option.propose)
    .slice(0, bornerChoixMax(choixMax, options.length))
    .map((option) => option.stepId);
}

/** Compte des spécialistes retenus : seuls ceux de la liste comptent, et une même étape n'est comptée qu'une fois. */
export function compteChoix(options: readonly ChoixPropose[], selection: readonly string[]): number {
  return retenus(options, selection).length;
}

/** Spécialistes retenus, dans l'ordre du déroulé (jamais dans l'ordre des clics) : c'est ce que le corps de la réponse porte. */
export function retenus(options: readonly ChoixPropose[], selection: readonly string[]): string[] {
  const voulus = new Set(selection.filter((stepId) => typeof stepId === "string"));
  return options.filter((option) => voulus.has(option.stepId)).map((option) => option.stepId);
}

/**
 * Validité du choix : de 1 à `choixMax` spécialistes, tous pris dans la liste fermée. Une sélection vide n'est pas un choix —
 * « aucun ne convient » est un chemin à part, avec sa propre réponse.
 */
export function choixValide(options: readonly ChoixPropose[], selection: readonly string[], choixMax: number): boolean {
  const n = compteChoix(options, selection);
  return n >= 1 && n <= bornerChoixMax(choixMax, options.length);
}

/** Une case de plus est-elle permise ? (Les cases déjà cochées restent décochables.) */
export function peutCocher(options: readonly ChoixPropose[], selection: readonly string[], choixMax: number): boolean {
  return compteChoix(options, selection) < bornerChoixMax(choixMax, options.length);
}

/** Case cochée ou décochée : la sélection reste dans la liste fermée et ne dépasse jamais `choixMax`. */
export function basculer(options: readonly ChoixPropose[], selection: readonly string[], stepId: string, choixMax: number): string[] {
  const courants = retenus(options, selection);
  if (courants.includes(stepId)) return courants.filter((id) => id !== stepId);
  if (!options.some((option) => option.stepId === stepId)) return courants;
  if (!peutCocher(options, courants, choixMax)) return courants;
  return retenus(options, [...courants, stepId]);
}

/** Libellé de [Continuer avec {n} spécialiste(s) (≈ {x} $)] : le coût de la SUITE, écrit par montant(). */
export function libelleContinuer(n: number, suiteUsd: number): string {
  return remplir(E.choix.continuer, { n: Math.max(0, Math.trunc(n)), x: montant(suiteUsd) });
}

/** Phrase de proposition : les titres proposés, puis la raison de l'aiguilleur, puis l'avertissement « c'est une IA ». */
export function phraseProposition(options: readonly ChoixPropose[], raison: string): string | null {
  const titres = options.filter((option) => option.propose).map((option) => option.titre);
  const dite = propre(raison);
  if (titres.length === 0 || dite === "") return null;
  return remplir(E.choix.proposition, { choix: titres.join(SEPARATEUR), raison: dite });
}

/** Entrée de la carte de choix : la pause (textes DÉJÀ bornés par l'appelant) et la sélection courante. */
export interface ChoixEntree {
  options: readonly ChoixPropose[];
  /** Raison de l'aiguilleur, déjà bornée à CHOIX_RAISON_MAX par l'appelant. */
  raison: string;
  choixMax: unknown;
  /** Coût de la suite du chemin (pause.suite.typique). */
  suiteUsd: number;
  selection: readonly string[];
}

/** Carte de choix complète : titre, proposition (raison masquée), cases, maximum et trois boutons. */
export function vueChoix(entree: ChoixEntree): TeamChoiceView {
  const options = optionsDe(entree.options);
  const choixMax = bornerChoixMax(entree.choixMax, options.length);
  const lisible = choixLisible(options);
  const selection = retenus(options, entree.selection);
  return {
    titre: E.choix.titre,
    proposition: lisible ? phraseProposition(options, entree.raison) : null,
    illisible: lisible ? null : E.choix.illisible,
    cases: options.map((option) => ({ stepId: option.stepId, titre: option.titre, coche: selection.includes(option.stepId) })),
    maximum: remplir(E.choix.maximum, { n: choixMax }),
    choixMax,
    continuer: libelleContinuer(selection.length, entree.suiteUsd),
    continuerActif: choixValide(options, selection, choixMax),
    aucunConvient: E.choix.aucunConvient,
    arreter: E.choix.arreter,
  };
}

// --- Lecture du livrable : chemin « aucun » (C §9.5) et journal de relecture (C §9.6) -------------------------------------------
// Les deux livrables sont écrits par `deliverable()` de ./flow.ts (L42a) avec les phrases de ./construction-texts.ts, reprises
// là-bas PAR VALEUR (égalité à l'octet vérifiée par server/flow-relecture-aiguillage.test.ts). On les DÉCOUPE, jamais on ne les
// réécrit : le texte montré reste celui que le cockpit a injecté dans la conversation.

/** Échappe un texte pour en faire une expression régulière littérale. */
function echappe(texte: string): string {
  return texte.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** Motif d'un gabarit dont « {n} » est un nombre. */
function motifDe(gabarit: string): RegExp {
  return new RegExp(`^${echappe(gabarit).replaceAll(String.raw`\{n\}`, String.raw`\d+`)}$`);
}

/** Motif de la phrase de repli, dont « {assistant} » est capturé : c'est de là que vient le nom de l'assistant proposé. */
const AUCUN_REPLI = new RegExp(`^${echappe(E.aucun.repli).replaceAll(String.raw`\{assistant\}`, "(.+)")}$`);

/**
 * Chemin « aucun ne convient » lu sur le livrable d'un aiguillage (D-5-13). `null` : ce livrable n'est pas celui d'un « aucun »
 * — rien n'est alors proposé. Le nom de l'assistant vient de la phrase de repli, écrite par `deliverable()` quand le bloc en
 * nomme un ; sans elle, `assistant` et `envoyer` restent nuls et la carte n'offre AUCUN bouton (P3 : jamais un renvoi vers un
 * assistant que le cockpit ne connaît pas).
 */
export function aucunDuLivrable(livrable: unknown): TeamAucunView | null {
  const blocs = (typeof livrable === "string" ? livrable : "").split("\n\n").map((bloc) => bloc.trim());
  if (!blocs.includes(E.aucun.phrase)) return null;
  let assistant: string | null = null;
  for (const bloc of blocs) {
    const nom = propre(AUCUN_REPLI.exec(bloc)?.[1]);
    if (nom !== "") {
      assistant = nom;
      break;
    }
  }
  return { assistant, envoyer: assistant === null ? null : E.aucun.envoyer };
}

/** Journal de relecture séparé du livrable, pour être rendu REPLIÉ sous le résultat. */
export interface JournalRelecture {
  /** Livrable sans son journal ni ses notes. */
  resultat: string;
  /** « Journal de relecture » ; null quand le livrable n'en porte pas. */
  titre: string | null;
  /** Corps du journal (tours et verdicts), tel que l'exécuteur l'a écrit ; vide sans journal. */
  texte: string;
  /** Notes d'honnêteté ÉCRITES PAR LE COCKPIT, sorties de la fin du livrable, dans leur ordre d'écriture. */
  notes: string[];
}

const NOTE_NON_CONCLUE = motifDe(E.relecture.nonConclue);

/** Une ligne est-elle une note d'honnêteté de la relecture (et non un morceau du travail des assistants) ? */
export function estNoteRelecture(ligne: string): boolean {
  const seule = propre(ligne);
  return seule === E.relecture.nonRelue || NOTE_NON_CONCLUE.test(seule);
}

/**
 * Sépare le livrable d'une relecture : le résultat, le journal (titre « ## Journal de relecture ») et les notes d'honnêteté
 * écrites en dessous. Le texte n'est jamais réécrit : il est seulement découpé, pour que la carte replie le journal.
 * `notesEcrites` : les notes que le COCKPIT a écrites sous ce livrable, dites par l'appelant d'après l'état ENREGISTRÉ du
 * lancement (team-view-model.ts, `ecritParLeCockpit`), jamais devinées ici. Clôture 5b, tour 4 : elles ne sortent du texte que
 * si elles le TERMINENT, à l'octet et dans cet ordre ; une phrase qui leur ressemble, écrite par une IA (« Relecture non
 * conclue après 7 tours… » à la fin d'une relecture au verdict illisible, les deux notes recopiées sous un premier jet),
 * reste dans le texte, rendue comme le reste du travail des assistants — le cockpit ne la signe jamais.
 */
export function journalRelecture(livrable: string, notesEcrites: readonly string[]): JournalRelecture {
  const texte = typeof livrable === "string" ? livrable : "";
  const blocs = texte.split("\n\n");
  const attendues: readonly string[] = Array.isArray(notesEcrites) ? notesEcrites : [];
  // Seules des notes de la relecture sortent du texte, toutes ensemble, et jamais le texte entier.
  const fin = blocs.slice(blocs.length - attendues.length);
  const terminent = attendues.length > 0 && attendues.length < blocs.length && attendues.every((note, i) => estNoteRelecture(note) && propre(fin[i]) === note);
  const notes = terminent ? [...attendues] : [];
  if (terminent) blocs.splice(blocs.length - notes.length);
  const entete = `## ${E.relecture.journal}`;
  const debut = blocs.findIndex((bloc) => bloc.trim() === entete);
  if (debut === -1) return { resultat: blocs.join("\n\n"), titre: null, texte: "", notes };
  return {
    resultat: blocs.slice(0, debut).join("\n\n"),
    titre: E.relecture.journal,
    texte: blocs.slice(debut + 1).join("\n\n"),
    notes,
  };
}
