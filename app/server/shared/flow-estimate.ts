// Estimation d'un déroulé d'équipe (itération 4, plan d'exécution it4 §6 fiche L36b et §4.1.1 ; spécification §3.1 l.129, §6
// l.1049 ; conception C §6.4 ; étude A §6 « estimateHash » ; décisions D-eq-19 et A4/D-eq-17) : module PUR (ni « node: », ni
// process, ni horloge, ni aléa, ni réseau), partagé avec l'interface.
//
// Ce module ne lit rien : le serveur (L37p) lui passe les lectures déjà faites (assistants, IA de chaque étape, tarifs, moyennes
// observées) et calcule lui-même l'empreinte SHA-256 du texte canonique rendu ici (node:crypto est interdit dans server/shared).
//
// Ordre et relais : l'ordre d'exécution vient de planSteps et la sémantique de `recoit` de receivedFrom (team-limits.ts, T4),
// consommées telles quelles ; aucune autre lecture de `recoit` n'est écrite ici (plan §4.1.1, constat n° 6). Aucun import de
// flow.ts (L36a, écrit en parallèle dans la même vague).
//
// Honnêteté « En général / au plus » (§6 l.1049, P3) :
// - « en général » = typique = moyenne de vos lancements dès OBSERVED_MIN_SAMPLES étapes terminées, sinon le profil de taille ;
// - « au plus » = maximum = le profil de la taille au-dessus (up : S → M, M → L, L → L × 2), jamais plus bas que « en général » ;
// - `plafond` = maximum : le montant est rendu vrai par l'ARRÊT au plafond (L37c), pas par `steps`, qui n'est qu'une consigne
//   donnée à l'IA (mesures ME-2 et ME-7, report MX-EQ au train de V0, §2 « T4t et L36b ») ;
// - `depassementUnAppel` chiffre ce qu'un appel déjà parti peut ajouter au-delà du plafond (§2.1 l.66).
import { type ModelPrice, ratesFor, roundUsd } from "../pricing.ts";
import { chooseEstimate, estimateTaskCost, TASK_PROFILES, type TaskSize, type Tier } from "./assistant-rules.ts";
import { planSteps, receivedFrom } from "./team-limits.ts";
import type { Flow, FlowEstimate, FlowProblem, FlowStep, StepAssistant, StepEstimate, TeamStepState } from "./team-types.ts";

// --- Contexte -------------------------------------------------------------------------------------------------------------------

/** IA retenue pour une étape : niveau résolu en mode Avancé, IA propre de l'assistant sinon (décision n° 3). */
export interface StepIa {
  /** « fournisseur/IA ». */
  model: string;
  /** Réflexion (variante d'appel), null sans variante. */
  variant: string | null;
  niveau: Tier | null;
  /** Nom lisible de l'IA, null s'il est inconnu. */
  label: string | null;
}

/**
 * Moyenne observée d'une étape (magasin, L37s : `observedStepCost`). `avgUsd` null = aucune étape terminée ; `samples` = nombre
 * d'étapes terminées prises dans la moyenne. Le seuil OBSERVED_MIN_SAMPLES est appliqué ICI (chooseEstimate), jamais par
 * l'appelant : le module doit pouvoir être contrôlé à 4 puis à 5 échantillons.
 */
export interface ObservedStepCost {
  avgUsd: number | null;
  samples: number;
}

/** Lectures déjà faites, passées à l'estimation (aucune requête n'est émise depuis ce module). */
export interface FlowEstimateContext {
  /** Assistants lus pour ce dossier : une étape dont l'assistant manque n'est pas estimée (étape marquée). */
  assistants: ReadonlyMap<string, StepAssistant>;
  /** IA de l'étape ; null : aucune IA disponible (problème `niveau-indisponible`, estimateProblems). */
  iaDe(step: FlowStep): StepIa | null;
  /** Tarifs de l'IA ; null : prix inconnu (étape marquée, estimation nulle pour elle). */
  prix(model: string): ModelPrice | null;
  /** Moyenne observée pour ce couple assistant/IA ; null si elle n'est pas connue. */
  observe(assistant: string, model: string): ObservedStepCost | null;
  /** Étapes lancées en même temps au plus (réglage teams.concurrentSteps, borne FLOW_LIMITS.simultanees). */
  simultanees: number;
}

/** État des étapes d'un lancement (suiteEstimate) : dernière tentative de chaque étape ; une étape absente n'a pas été lancée. */
export interface FlowRunState {
  etapes: ReadonlyArray<{ stepId: string; state: TeamStepState }>;
}

// --- Taille au-dessus et coût d'un appel ------------------------------------------------------------------------------------------

/** Taille retenue pour l'estimation haute : S → M, M → L, L → L × 2 (plan it4, fiche L36b). */
export function up(taille: TaskSize): { taille: TaskSize; facteur: number } {
  switch (taille) {
    case "S":
      return { taille: "M", facteur: 1 };
    case "M":
      return { taille: "L", facteur: 1 };
    default:
      return { taille: "L", facteur: 2 };
  }
}

/** Estimation haute d'une étape : coût du profil de la taille au-dessus. */
export function maximumTaskCost(price: ModelPrice, taille: TaskSize): number {
  const suivante = up(taille);
  return roundUsd(estimateTaskCost(price, suivante.taille) * suivante.facteur);
}

/** Coût d'UN appel du profil : c'est ce qu'un appel déjà parti peut ajouter au-delà du plafond. */
export function unAppelCost(price: ModelPrice, taille: TaskSize): number {
  return roundUsd(estimateTaskCost(price, taille) / TASK_PROFILES[taille].calls);
}

/** Jetons de sortie d'une étape, par taille : ce que l'étape suivante relit en entrée quand elle reçoit son résultat. */
export const RELAY_OUTPUT_TOKENS: Readonly<Record<TaskSize, number>> = Object.freeze({
  S: TASK_PROFILES.S.output,
  M: TASK_PROFILES.M.output,
  L: TASK_PROFILES.L.output,
});

/** Coût du relais d'un résultat : jetons de sortie du producteur × prix d'entrée du receveur. */
export function relayCost(tailleProducteur: TaskSize, prixReceveur: ModelPrice): number {
  const jetons = RELAY_OUTPUT_TOKENS[tailleProducteur];
  return roundUsd((jetons * ratesFor(prixReceveur, jetons).input) / 1_000_000);
}

// --- Estimation -------------------------------------------------------------------------------------------------------------------

/** Étapes du déroulé par identifiant (une seule lecture des blocs, sans réécrire l'ordre de planSteps). */
function stepsById(flow: Flow): Map<string, FlowStep> {
  const out = new Map<string, FlowStep>();
  for (const block of flow.blocs) {
    if (block.type === "etape") out.set(block.etape.id, block.etape);
    else if (block.type === "avis") for (const step of [...block.avis, block.synthese]) out.set(step.id, step);
  }
  return out;
}

interface StepLine {
  ligne: StepEstimate;
  unAppel: number;
  prix: ModelPrice | null;
}

function estimateStep(step: FlowStep, ctx: FlowEstimateContext): StepLine {
  const ia = ctx.iaDe(step);
  const installe = ctx.assistants.has(step.assistant);
  const prix = ia && installe ? ctx.prix(ia.model) : null;
  const ligne: StepEstimate = {
    stepId: step.id,
    titre: step.titre,
    assistant: step.assistant,
    model: ia?.model ?? null,
    modelLabel: ia?.label ?? null,
    niveau: ia?.niveau ?? step.niveau,
    choisieParEquipe: step.niveau !== null,
    typique: null,
    maximum: null,
    source: "profil",
  };
  // Prix inconnu, IA absente ou assistant retiré : étape marquée, estimation nulle pour elle (report MX-EQ §4.2).
  if (!ia || !prix) return { ligne, unAppel: 0, prix: null };
  const observe = ctx.observe(step.assistant, ia.model);
  const choix = chooseEstimate(observe, prix, step.taille);
  const typique = choix ? choix.usd : estimateTaskCost(prix, step.taille);
  // « Au plus » n'est jamais plus bas que « en général » (§6 l.1049) : une moyenne observée élevée relève l'estimation haute,
  // sinon le plafond arrêterait l'équipe sous le montant annoncé « en général ».
  const maximum = Math.max(maximumTaskCost(prix, step.taille), typique);
  return {
    ligne: { ...ligne, typique, maximum, source: choix?.source === "observed" ? "observe" : "profil" },
    unAppel: unAppelCost(prix, step.taille),
    prix,
  };
}

/** Estimation d'un chemin donné (identifiants dans l'ordre de planSteps) : cœur commun d'estimateFlow et de suiteEstimate. */
function estimateChemin(flow: Flow, ctx: FlowEstimateContext, chemin: readonly string[]): FlowEstimate {
  const steps = stepsById(flow);
  const parEtape: StepEstimate[] = [];
  const appels: number[] = [];
  let typique = 0;
  let maximum = 0;
  let relais = 0;
  for (const stepId of chemin) {
    const step = steps.get(stepId);
    if (!step) continue;
    const { ligne, unAppel, prix } = estimateStep(step, ctx);
    parEtape.push(ligne);
    typique += ligne.typique ?? 0;
    maximum += ligne.maximum ?? 0;
    appels.push(unAppel);
    // Relais : un coût par résultat reçu, SELON receivedFrom (T4). Un avis (« demande ») n'en reçoit aucun ; la synthèse d'un
    // bloc d'avis en reçoit un par avis.
    if (!prix) continue;
    for (const source of receivedFrom(flow, stepId)) {
      const producteur = steps.get(source);
      if (producteur) relais += relayCost(producteur.taille, prix);
    }
  }
  const dessus = appels.toSorted((a, b) => b - a).slice(0, Math.max(0, ctx.simultanees));
  const total = roundUsd(typique + relais);
  const haut = roundUsd(maximum + relais);
  return {
    typique: total,
    maximum: haut,
    // Le plafond EST l'estimation haute : le cockpit arrête l'équipe quand le coût l'atteint (P3, L37c).
    plafond: haut,
    etapesFacturees: parEtape.length,
    depassementUnAppel: roundUsd(dessus.reduce((somme, valeur) => somme + valeur, 0)),
    relais: roundUsd(relais),
    parEtape,
  };
}

/** Estimation du chemin complet (en itération 4, chemin typique = chemin maximal : aucun bloc facultatif ni aiguillage). */
export function estimateFlow(flow: Flow, ctx: FlowEstimateContext): FlowEstimate {
  return estimateChemin(
    flow,
    ctx,
    planSteps(flow).map((planned) => planned.stepId),
  );
}

/**
 * Coût du reste du chemin (bouton de pause, relance) : étapes non « terminee », prises dans l'ordre de planSteps de T4 — le coût
 * ne dépend pas de l'ordonnanceur de L36a. Les relais sont recomptés par receivedFrom : le résultat d'une étape déjà terminée
 * reste à transmettre, donc à payer en entrée.
 */
export function suiteEstimate(flow: Flow, state: FlowRunState, ctx: FlowEstimateContext): FlowEstimate {
  const terminees = new Set(state.etapes.filter((etape) => etape.state === "terminee").map((etape) => etape.stepId));
  return estimateChemin(
    flow,
    ctx,
    planSteps(flow)
      .map((planned) => planned.stepId)
      .filter((stepId) => !terminees.has(stepId)),
  );
}

/**
 * Problèmes constatés à l'estimation : une étape sans IA disponible donne « niveau-indisponible » (bloquant). Les problèmes de
 * grammaire (assistant absent, droits, bornes) restent à validateFlow (L36a) : FlowEstimate ne porte aucune liste de problèmes.
 */
export function estimateProblems(flow: Flow, ctx: FlowEstimateContext): FlowProblem[] {
  const steps = stepsById(flow);
  const problems: FlowProblem[] = [];
  for (const planned of planSteps(flow)) {
    const step = steps.get(planned.stepId);
    if (!step || ctx.iaDe(step) !== null) continue;
    const probleme: FlowProblem = { code: "niveau-indisponible", bloc: planned.blocId, etape: step.id, bloquant: true, nom: step.assistant };
    if (step.niveau !== null) probleme.niveau = step.niveau;
    problems.push(probleme);
  }
  return problems;
}

// --- Texte canonique de l'empreinte (D-eq-19) ---------------------------------------------------------------------------------

/** Une étape dans le texte canonique : assistant, IA, réflexion, tarifs d'entrée et de sortie (D-eq-19). */
export interface CanonicalStep {
  assistant: string;
  ia: string | null;
  reflexion: string | null;
  /** Tarif d'entrée, en centimes par million de jetons ; null si le prix est inconnu. */
  tarifEntree: number | null;
  /** Tarif de sortie, en centimes par million de jetons ; null si le prix est inconnu. */
  tarifSortie: number | null;
}

/**
 * Ce que l'empreinte d'estimation couvre (D-eq-19) : le déroulé (par son empreinte), l'IA, la réflexion et les tarifs de chaque
 * étape, le plafond retenu, les réglages d'équipe et le budget mensuel. L'instantané des lectures y est lié (A4, D-eq-17) : le
 * texte doit changer dès qu'une IA, un prix, un plafond ou la simultanéité change.
 */
export interface EstimateCanonicalInput {
  flowSha256: string;
  etapes: readonly CanonicalStep[];
  /** Plafond d'arrêt retenu, en dollars. */
  plafond: number;
  teams: {
    /** Réglage teams.maxCapUsd ; null : plafond calculé sur le budget. */
    maxCapUsd: number | null;
    /** Réglage teams.concurrentSteps (simultanéité). */
    concurrentSteps: number;
  };
  budget: {
    /** Réglage budget.monthlyUsd ; null : aucun budget mensuel. */
    monthlyUsd: number | null;
  };
}

/** Montant en centimes entiers : aucun flottant dans le texte canonique. Un tarif change l'empreinte dès 0,01 $ par million. */
function centimes(usd: number | null): number | null {
  if (usd === null || !Number.isFinite(usd)) return null;
  return Math.round(usd * 100);
}

/** JSON à clés triées (ordre des codes de caractères), tableaux dans leur ordre : deux entrées égales donnent le même texte. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Texte canonique de l'estimation (D-eq-19). L'EMPREINTE (`estimateSha256`) est calculée côté serveur (L37p) : node:crypto est
 * interdit dans un module partagé.
 */
export function estimateCanonical(input: EstimateCanonicalInput): string {
  // Écrit dans l'ordre de D-eq-19 ; c'est canonicalJson qui trie les clés, à tous les niveaux.
  return canonicalJson({
    flowSha256: input.flowSha256,
    etapes: input.etapes.map((etape) => ({
      assistant: etape.assistant,
      ia: etape.ia,
      reflexion: etape.reflexion,
      tarifEntree: centimes(etape.tarifEntree),
      tarifSortie: centimes(etape.tarifSortie),
    })),
    plafond: centimes(input.plafond),
    teams: { maxCapUsd: centimes(input.teams.maxCapUsd), concurrentSteps: input.teams.concurrentSteps },
    budget: { monthlyUsd: centimes(input.budget.monthlyUsd) },
  });
}

/**
 * Étapes du texte canonique, lues comme l'estimation les a lues (ordre de planSteps, IA d'`iaDe`, tarifs de `prix`) : L37p bâtit
 * ainsi l'empreinte sur exactement ce qui a servi au calcul (A4, D-eq-17). Tarifs de base de la grille, hors paliers de contexte.
 */
export function canonicalSteps(flow: Flow, ctx: FlowEstimateContext): CanonicalStep[] {
  const steps = stepsById(flow);
  const out: CanonicalStep[] = [];
  for (const planned of planSteps(flow)) {
    const step = steps.get(planned.stepId);
    if (!step) continue;
    const ia = ctx.iaDe(step);
    const prix = ia ? ctx.prix(ia.model) : null;
    out.push({
      assistant: step.assistant,
      ia: ia?.model ?? null,
      reflexion: ia?.variant ?? null,
      tarifEntree: prix ? prix.rates.input : null,
      tarifSortie: prix ? prix.rates.output : null,
    });
  }
  return out;
}
