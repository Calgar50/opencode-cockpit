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
import { choixMaxDe, planSteps, receivedFrom, toursDe } from "./team-limits.ts";
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

/**
 * État des étapes d'un lancement (suiteEstimate) : dernière tentative de chaque étape ; une étape absente n'a pas été lancée.
 * `tours` (5b) : nombre de PASSAGES déjà faits par l'étape. Depuis L42a une même étape revient plusieurs fois sur le chemin
 * d'une relecture, et un seul état ne dit pas combien de fois elle est passée : sans ce compte, une étape « terminee » au tour 1
 * retirerait du reste TOUTES ses révisions à venir. Absent : 1 passage pour « terminee », 0 sinon (comportement de l'it4).
 */
export interface FlowRunState {
  etapes: ReadonlyArray<{ stepId: string; state: TeamStepState; tours?: number }>;
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
    else if (block.type === "relecture") for (const step of [block.auteur, block.relecteur]) out.set(step.id, step);
    else if (block.type === "aiguillage") {
      for (const step of [block.aiguilleur, ...block.specialistes, ...(block.synthese ? [block.synthese] : [])]) out.set(step.id, step);
    }
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

/**
 * Une entrée du chemin estimé. `groupe` : bloc d'aiguillage dont l'étape est un spécialiste PROPOSÉ — toutes les propositions
 * sont estimées (la feuille de lancement doit pouvoir les nommer), mais « au plus » n'en paie que `garde`, le nombre que le
 * bloc laisse confirmer. Sans `groupe`, l'entrée est toujours comptée.
 */
interface CheminEntree {
  stepId: string;
  blocId: string;
  groupe?: string;
  garde?: number;
}

/**
 * Chemin estimé : l'ordre de planSteps (T4), où les spécialistes d'un aiguillage sont remplacés par TOUS ceux que le bloc
 * propose. L'aiguilleur peut proposer n'importe lequel, la pause de choix les liste tous et l'ordonnanceur lance sans réserve
 * ceux que l'on confirme (flow.ts, L42a) : borner « au plus » aux premiers ÉCRITS annoncerait un plafond que le choix réel peut
 * dépasser, et la feuille tairait des spécialistes qu'elle doit nommer (§13.2, P3). Le nombre payé reste `choixMaxDe` ; ce sont
 * les plus coûteux qui sont retenus, donc le montant ne dépend plus de l'ordre d'écriture.
 */
function cheminEstime(flow: Flow, chemin: "typique" | "maximal"): CheminEntree[] {
  const blocs = new Map(flow.blocs.map((block) => [block.id, block]));
  const ouverts = new Set<string>();
  const out: CheminEntree[] = [];
  for (const planned of planSteps(flow, { chemin })) {
    const block = blocs.get(planned.blocId);
    if (chemin === "maximal" && block?.type === "aiguillage" && planned.role === "specialiste") {
      if (ouverts.has(block.id)) continue;
      ouverts.add(block.id);
      const garde = choixMaxDe(block);
      for (const step of Array.isArray(block.specialistes) ? block.specialistes : []) {
        out.push({ stepId: step.id, blocId: block.id, groupe: block.id, garde });
      }
      continue;
    }
    out.push({ stepId: planned.stepId, blocId: planned.blocId });
  }
  return out;
}

/** Coût d'une entrée du chemin : son estimation propre et les relais qu'elle paie en entrée. */
interface CoutEntree {
  typique: number;
  maximum: number;
  relais: number;
}

/** Estimation d'un chemin donné (entrées dans l'ordre de cheminEstime) : cœur commun d'estimateFlow et de suiteEstimate. */
function estimateChemin(flow: Flow, ctx: FlowEstimateContext, chemin: readonly CheminEntree[]): FlowEstimate {
  const steps = stepsById(flow);
  const parEtape: StepEstimate[] = [];
  // Un appel par étape EN COURS : une étape ne compte qu'une fois, même quand le chemin la fait revenir (tours d'une relecture).
  const appels = new Map<string, number>();
  // Spécialistes proposés d'un même aiguillage : seuls les `garde` plus coûteux entrent dans les sommes (choixMaxDe).
  const groupes = new Map<string, { garde: number; couts: CoutEntree[] }>();
  let typique = 0;
  let maximum = 0;
  let relais = 0;
  let comptees = 0;
  for (const entree of chemin) {
    const step = steps.get(entree.stepId);
    if (!step) continue;
    const { ligne, unAppel, prix } = estimateStep(step, ctx);
    parEtape.push(ligne);
    if (!appels.has(entree.stepId)) appels.set(entree.stepId, unAppel);
    // Relais : un coût par résultat reçu, SELON receivedFrom (T4). Un avis (« demande ») n'en reçoit aucun ; la synthèse d'un
    // bloc d'avis en reçoit un par avis ; une étape à `recoit: {etapes}` (5b) en reçoit un par étape listée.
    let relaisEtape = 0;
    if (prix) {
      for (const source of receivedFrom(flow, entree.stepId)) {
        const producteur = steps.get(source);
        if (producteur) relaisEtape += relayCost(producteur.taille, prix);
      }
    }
    const cout: CoutEntree = { typique: ligne.typique ?? 0, maximum: ligne.maximum ?? 0, relais: relaisEtape };
    if (entree.groupe === undefined) {
      typique += cout.typique;
      maximum += cout.maximum;
      relais += cout.relais;
      comptees += 1;
      continue;
    }
    const groupe = groupes.get(entree.groupe) ?? { garde: entree.garde ?? 0, couts: [] };
    groupe.garde = entree.garde ?? groupe.garde;
    groupe.couts.push(cout);
    groupes.set(entree.groupe, groupe);
  }
  // « Au plus » d'un aiguillage : les `garde` propositions les plus chères, quel que soit leur rang d'écriture.
  for (const groupe of groupes.values()) {
    const retenues = groupe.couts
      .toSorted((a, b) => b.maximum + b.relais - (a.maximum + a.relais))
      .slice(0, Math.max(0, groupe.garde));
    for (const cout of retenues) {
      typique += cout.typique;
      maximum += cout.maximum;
      relais += cout.relais;
    }
    comptees += retenues.length;
  }
  const dessus = [...appels.values()].toSorted((a, b) => b - a).slice(0, Math.max(0, ctx.simultanees));
  const total = roundUsd(typique + relais);
  const haut = roundUsd(maximum + relais);
  return {
    typique: total,
    maximum: haut,
    // Le plafond EST l'estimation haute : le cockpit arrête l'équipe quand le coût l'atteint (P3, L37c).
    plafond: haut,
    // Appels que « au plus » paie : les propositions d'un aiguillage qui dépassent `choixMax` sont estimées, jamais facturées.
    etapesFacturees: comptees,
    depassementUnAppel: roundUsd(dessus.reduce((somme, valeur) => somme + valeur, 0)),
    relais: roundUsd(relais),
    parEtape,
  };
}

/**
 * Estimation d'un déroulé : « en général » se compte sur le chemin TYPIQUE, « au plus » sur le chemin MAXIMAL, tous deux rendus
 * par planSteps (T4, étendue par L42a). Pour les formes de l'itération 4 les deux chemins sont les mêmes : l'estimation ne
 * change pas d'un iota. Pour une relecture ou un aiguillage, « au plus » couvre tous les tours et tous les spécialistes que le
 * plafond doit payer — c'est ce qui rend « au plus » vrai (P3). Les spécialistes d'un aiguillage sont TOUS estimés, et « au
 * plus » retient les `choixMax` plus coûteux (cheminEstime) : l'ordre d'écriture ne décide plus du plafond annoncé.
 * `parEtape` garde UNE ligne par étape, dans l'ordre du chemin maximal : une étape qui revient à chaque tour n'est pas répétée.
 */
export function estimateFlow(flow: Flow, ctx: FlowEstimateContext): FlowEstimate {
  const maximal = estimateChemin(flow, ctx, cheminEstime(flow, "maximal"));
  const typique = estimateChemin(flow, ctx, cheminEstime(flow, "typique"));
  const vues = new Set<string>();
  const parEtape = maximal.parEtape.filter((ligne) => !vues.has(ligne.stepId) && (vues.add(ligne.stepId), true));
  const repetitions = repetitionsDe(flow);
  return { ...maximal, typique: typique.typique, parEtape, ...(repetitions === null ? {} : { repetitions }) };
}

/**
 * Répétitions que le chemin maximal couvre (5b) : tours d'une relecture et spécialistes d'un aiguillage. Ce sont les nombres
 * des lignes « 1 tour en général, {n} au plus » et « 1 spécialiste en général, {n} au plus » (construction-texts.ts, §4.3) ;
 * ce module ne les met pas en phrase, il ne porte aucun texte. `null` : le déroulé n'a aucune de ces deux formes.
 */
function repetitionsDe(flow: Flow): { tours: number; specialistes: number } | null {
  let tours = 0;
  let specialistes = 0;
  for (const block of flow.blocs) {
    if (block.type === "relecture") tours = Math.max(tours, toursDe(block));
    if (block.type === "aiguillage") specialistes = Math.max(specialistes, choixMaxDe(block));
  }
  return tours === 0 && specialistes === 0 ? null : { tours, specialistes };
}

/** Passages déjà faits par une étape : `tours` quand l'exécuteur le donne, sinon 1 pour « terminee » et 0 autrement (it4). */
function passagesFaits(etape: FlowRunState["etapes"][number]): number {
  const plancher = etape.state === "terminee" ? 1 : 0;
  const brut = Math.trunc(Number(etape.tours));
  return Number.isFinite(brut) ? Math.max(plancher, brut) : plancher;
}

/**
 * Coût du reste du chemin (bouton de pause, relance) : PASSAGES non encore faits, pris dans l'ordre du chemin maximal — le coût
 * ne dépend pas de l'ordonnanceur de L36a. Le filtre porte sur les passages et non sur les identifiants : depuis L42a une même
 * étape revient à chaque tour d'une relecture, et retirer tous ses passages parce qu'un seul est terminé ferait disparaître du
 * « Coût du reste » les révisions à venir — donc du plafond d'une relance, qui vaut « déjà dépensé + reste » (team-preflight).
 * Les relais sont recomptés par receivedFrom : le résultat d'une étape déjà terminée reste à transmettre, donc à payer en entrée.
 */
export function suiteEstimate(flow: Flow, state: FlowRunState, ctx: FlowEstimateContext): FlowEstimate {
  const faits = new Map<string, number>();
  for (const etape of state.etapes) {
    const compte = passagesFaits(etape);
    if (compte > 0) faits.set(etape.stepId, (faits.get(etape.stepId) ?? 0) + compte);
  }
  const retires = new Map<string, number>();
  const reste: CheminEntree[] = [];
  for (const entree of cheminEstime(flow, "maximal")) {
    const restant = faits.get(entree.stepId) ?? 0;
    if (restant > 0) {
      faits.set(entree.stepId, restant - 1);
      if (entree.groupe !== undefined) retires.set(entree.groupe, (retires.get(entree.groupe) ?? 0) + 1);
      continue;
    }
    reste.push(entree);
  }
  // Un spécialiste déjà terminé occupe une des places que « au plus » paie : le reste n'en couvre pas une de plus.
  const ajuste = reste.map((entree) =>
    entree.groupe === undefined ? entree : { ...entree, garde: Math.max(0, (entree.garde ?? 0) - (retires.get(entree.groupe) ?? 0)) },
  );
  return estimateChemin(flow, ctx, ajuste);
}

/**
 * Problèmes constatés à l'estimation : une étape sans IA disponible donne « niveau-indisponible » (bloquant). Le chemin est
 * celui de l'estimation, donc TOUS les spécialistes proposés d'un aiguillage y passent : l'un d'eux peut être confirmé, son IA
 * doit donc être disponible. Un problème par étape, jamais un par passage. Les problèmes de grammaire (assistant absent, droits,
 * bornes) restent à validateFlow (L36a) : FlowEstimate ne porte aucune liste de problèmes.
 */
export function estimateProblems(flow: Flow, ctx: FlowEstimateContext): FlowProblem[] {
  const steps = stepsById(flow);
  const problems: FlowProblem[] = [];
  const vues = new Set<string>();
  for (const entree of cheminEstime(flow, "maximal")) {
    const step = steps.get(entree.stepId);
    if (!step || vues.has(entree.stepId) || ctx.iaDe(step) !== null) continue;
    vues.add(entree.stepId);
    const probleme: FlowProblem = { code: "niveau-indisponible", bloc: entree.blocId, etape: step.id, bloquant: true, nom: step.assistant };
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
 * Étapes du texte canonique, lues comme l'estimation les a lues (ordre du chemin estimé, IA d'`iaDe`, tarifs de `prix`) : L37p
 * bâtit ainsi l'empreinte sur exactement ce qui a servi au calcul (A4, D-eq-17). Les spécialistes proposés d'un aiguillage y
 * figurent tous, comme dans l'estimation. Tarifs de base de la grille, hors paliers de contexte.
 */
export function canonicalSteps(flow: Flow, ctx: FlowEstimateContext): CanonicalStep[] {
  const steps = stepsById(flow);
  const out: CanonicalStep[] = [];
  for (const entree of cheminEstime(flow, "maximal")) {
    const step = steps.get(entree.stepId);
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
