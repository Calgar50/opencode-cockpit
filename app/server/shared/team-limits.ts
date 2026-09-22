// Valeurs et fonctions pures des équipes (itération 4, plan d'exécution it4 §4.1.1, T4, D-eq-02) : version et bornes du déroulé,
// listes exécutables des unions fermées de team-types.ts (clés des textes de T4t, croisement de V0), tables de transitions lues
// par le magasin (L37s), ordre d'exécution (planSteps) et sémantique de `recoit` (receivedFrom). planSteps et receivedFrom sont
// les fonctions de référence : L36a (ordonnanceur, messages) et L36b (estimation, relais) les consomment sans les réécrire ; un
// défaut trouvé ici devient une demande de contrat au train. Imports : ./team-types.ts, en types seulement.
import type {
  Flow,
  FlowBlock,
  FlowProblemCode,
  FlowStep,
  PlannedOrder,
  StepInput,
  StepInputName,
  TeamConfirmation,
  TeamErrorCode,
  TeamGuardCode,
  TeamRunCause,
  TeamRunState,
  TeamRunTransitions,
  TeamStepState,
  TeamStepTransitions,
} from "./team-types.ts";

/** Version du JSON « Flow » (colonne teams.flow). */
export const FLOW_VERSION = 1;

/**
 * Bornes du déroulé. `blocsTravail` : blocs de travail, pauses exceptées ; `etapes` : toutes les étapes, avis, synthèses et
 * spécialistes compris ; `simultanees` : étapes lancées ensemble au plus (réglage teams.concurrentSteps, mode Avancé) ;
 * `relaisCaracteres` : résultat transmis à une étape ; `demande`, `fichiers`, `precision` : corps des routes de lancement.
 * Ajouts de la 5b (L42a) : `methodesParEtape` (méthodes « consigne » d'une étape), `specialistesMin`/`specialistesMax` et
 * `choixMax` (aiguillage), `toursMax` (relecture). `methodesParEtape` vaut METHODS_PER_STEP de construction-constants.ts.
 */
export const FLOW_LIMITS = Object.freeze({
  blocsTravail: 5,
  etapes: 12,
  avisMin: 2,
  avisMax: 5,
  simultanees: 3,
  consigne: 4000,
  relaisCaracteres: 24000,
  demande: 20000,
  fichiers: 20,
  precision: 1000,
  methodesParEtape: 2,
  specialistesMin: 2,
  specialistesMax: 8,
  toursMax: 2,
  choixMax: 2,
});

/** Autres bornes des textes et des corps (types de team-types.ts, fiche T4 et tableau des routes du §4.1.5). */
export const TEAM_TEXT_LIMITS = Object.freeze({
  /** Titre d'une étape. */
  titreEtape: Object.freeze({ min: 2, max: 60 }),
  /** Message d'un bloc « pause ». */
  messagePause: 300,
  /** Titre d'une équipe (PUT /api/teams/:id). */
  titreEquipe: Object.freeze({ min: 3, max: 80 }),
  /** Description d'une équipe. */
  description: 300,
  /** Chemin d'une pièce jointe (D-eq-18). */
  cheminFichier: 512,
  /** Corps de POST /api/teams/preview, en octets (64 Kio). */
  apercuOctets: 64 * 1024,
});

/** Identifiant d'une étape ou d'un bloc dans un déroulé. */
export const STEP_ID_RE = /^[a-z0-9-]{1,24}$/;

/** Identifiant d'une équipe ou d'un exemple dans les routes (/api/teams/:id). Lancement : UUID ; sessions : shared/ids.ts. */
export const TEAM_ID_RE = /^[a-z0-9-]{1,40}$/;

// --- Listes exécutables des unions fermées --------------------------------------------------------------------------------------

/**
 * Membres d'une union, dans l'ordre d'écriture. L'objet `Record<union, true>` fait vérifier la liste par le compilateur : un
 * membre absent, un intrus ou une clé en double fait échouer `npm run typecheck`.
 */
function membersOf<K extends string>(record: Readonly<Record<K, true>>): readonly K[] {
  return Object.freeze(Object.keys(record) as K[]);
}

export const FLOW_BLOCK_TYPES = membersOf<FlowBlock["type"]>({ etape: true, avis: true, relecture: true, aiguillage: true, pause: true });

/** Noms fermés de `recoit` ; `{etapes}` (5b) n'est pas un nom : il se lit avec stepInputEtapes. */
export const STEP_INPUTS = membersOf<StepInputName>({ demande: true, precedent: true, tous: true });

/** `recoit` est l'un des trois noms fermés (et non la forme `{etapes}` de la 5b, ni une valeur inconnue d'un JSON non validé). */
export function isStepInputName(recoit: unknown): recoit is StepInputName {
  return typeof recoit === "string" && (STEP_INPUTS as readonly string[]).includes(recoit);
}

/**
 * Étapes nommées par `recoit: {etapes}` (5b, L42a), telles qu'elles sont écrites : identifiants non vides, sans doublon. Toute
 * autre valeur — un nom fermé, une forme inconnue d'un JSON non validé — rend null, et rien n'est transmis par cette voie.
 */
export function stepInputEtapes(recoit: unknown): string[] | null {
  if (typeof recoit !== "object" || recoit === null) return null;
  const liste = (recoit as { etapes?: unknown }).etapes;
  if (!Array.isArray(liste)) return null;
  const out: string[] = [];
  for (const id of liste) if (typeof id === "string" && id !== "" && !out.includes(id)) out.push(id);
  return out;
}

export const TEAM_CONFIRMATIONS = membersOf<TeamConfirmation>({ workspace: true, secret: true, plafond: true, budget: true });

export const FLOW_PROBLEM_CODES = membersOf<FlowProblemCode>({
  vide: true,
  "trop-de-blocs": true,
  "trop-d-etapes": true,
  "pause-mal-placee": true,
  "avis-nombre": true,
  "synthese-requise": true,
  "id-invalide": true,
  "id-double": true,
  titre: true,
  "consigne-longue": true,
  "recoit-invalide": true,
  "assistant-absent": true,
  "assistant-interne": true,
  "assistant-non-proposable": true,
  delegue: true,
  internet: true,
  "autorise-sans-demander": true,
  "propose-reporte": true,
  personnalise: true,
  "niveau-avance": true,
  "niveau-indisponible": true,
  "aiguillage-premier": true,
  specialistes: true,
  "relecteur-distinct": true,
  "meme-famille": true,
  "lien-arriere": true,
  "lien-avis": true,
  "lien-avance": true,
  methodes: true,
});

export const TEAM_RUN_STATES = membersOf<TeamRunState>({
  preparation: true,
  "en-cours": true,
  "attente-verification": true,
  "attente-budget": true,
  "attente-modification": true,
  "attente-choix": true,
  terminee: true,
  arretee: true,
  echec: true,
  interrompue: true,
  plafond: true,
});

export const TEAM_STEP_STATES = membersOf<TeamStepState>({
  prevue: true,
  "en-file": true,
  "en-cours": true,
  "attente-accord": true,
  terminee: true,
  echec: true,
  arretee: true,
  interrompue: true,
  plafond: true,
  "non-lancee": true,
  "non-choisi": true,
});

export const TEAM_RUN_CAUSES = membersOf<TeamRunCause>({
  vous: true,
  equipe: true,
  plafond: true,
  echec: true,
  rechargement: true,
  "redemarrage-cockpit": true,
  budget: true,
  modification: true,
  pause: true,
  changement: true,
});

export const TEAM_ERROR_CODES = membersOf<TeamErrorCode>({
  invalid: true,
  "not-found": true,
  "equipe-invalide": true,
  "mode-avance": true,
  "equipes-simple-fermees": true,
  "forbidden-directory": true,
  "fichier-refuse": true,
  "fournisseur-refuse": true,
  "ia-indisponible": true,
  "assistant-absent": true,
  "equipe-en-cours": true,
  "conversation-occupee": true,
  "instance-salle": true,
  "trop-d-equipes": true,
  "budget-guard": true,
  "budget-insuffisant": true,
  "plafond-trop-haut": true,
  "plafond-a-confirmer": true,
  "confirmation-workspace": true,
  "secret-probable": true,
  "estimation-perimee": true,
  "profondeur-delegation": true,
  "extension-configuree": true,
  "dossier-externe": true,
  "plancher-etape": true,
  "etape-consultable": true,
  "etat-incompatible": true,
  "pas-relancable": true,
  "deja-ajoute": true,
  "confirmation-requise": true,
  "opencode-injoignable": true,
  "a-venir": true,
});

/** Codes de la garde de rechargement de la 1.1, rendus tels quels (aucun texte dans T4t). */
export const TEAM_GUARD_CODES = membersOf<TeamGuardCode>({ "sessions-busy": true, "redemarrage-en-cours": true, "reponses-non-verifiables": true });

// --- Transitions ----------------------------------------------------------------------------------------------------------------

/**
 * Lancement : état → états permis. « terminee » et « arretee » sont finaux (aucune sortie) ; « echec », « interrompue » et
 * « plafond » n'admettent que la relance (« preparation », nouvelle tentative des étapes restantes, L37c) ou la fermeture
 * (« arretee », POST …/fermer). Lu à l'exécution par le magasin (L37s) par canTransition.
 * 5b (L42a) : « attente-choix » se rejoint depuis « en-cours » seulement — l'aiguilleur vient de finir — et n'en sort que vers
 * « en-cours » (spécialistes lancés), « terminee » (« aucun ne convient »), « arretee » ou « interrompue ».
 */
export const TEAM_RUN_TRANSITIONS: TeamRunTransitions = Object.freeze({
  preparation: Object.freeze([
    "en-cours",
    "attente-verification",
    "attente-budget",
    "attente-modification",
    "arretee",
    "echec",
    "interrompue",
    "plafond",
  ] as const),
  "en-cours": Object.freeze([
    "attente-verification",
    "attente-budget",
    "attente-modification",
    "attente-choix",
    "terminee",
    "arretee",
    "echec",
    "interrompue",
    "plafond",
  ] as const),
  "attente-verification": Object.freeze([
    "preparation",
    "en-cours",
    "attente-budget",
    "attente-modification",
    "arretee",
    "echec",
    "interrompue",
    "plafond",
  ] as const),
  "attente-budget": Object.freeze([
    "preparation",
    "en-cours",
    "attente-verification",
    "attente-modification",
    "arretee",
    "echec",
    "interrompue",
    "plafond",
  ] as const),
  "attente-modification": Object.freeze([
    "preparation",
    "en-cours",
    "attente-verification",
    "attente-budget",
    "arretee",
    "echec",
    "interrompue",
    "plafond",
  ] as const),
  "attente-choix": Object.freeze(["en-cours", "terminee", "arretee", "interrompue"] as const),
  terminee: Object.freeze([] as const),
  arretee: Object.freeze([] as const),
  echec: Object.freeze(["preparation", "arretee"] as const),
  interrompue: Object.freeze(["preparation", "arretee"] as const),
  plafond: Object.freeze(["preparation", "arretee"] as const),
});

/**
 * Étape (une ligne par tentative) : état → états permis. Les états finaux n'ont aucune sortie : une relance crée une nouvelle
 * tentative (nouvelle ligne), jamais un retour de la ligne finie. Un arrêt annule les étapes « prevue » et « en-file »
 * (« non-lancee »).
 * 5b (L42a) : « non-choisi » est l'état FINAL d'un spécialiste ou d'une synthèse d'aiguillage écarté par le choix. Il ne se
 * rejoint que depuis une étape qui n'a rien envoyé (« prevue », « en-file ») : rien n'a été facturé pour elle.
 */
export const TEAM_STEP_TRANSITIONS: TeamStepTransitions = Object.freeze({
  prevue: Object.freeze(["en-file", "en-cours", "echec", "non-lancee", "non-choisi"] as const),
  "en-file": Object.freeze(["en-cours", "echec", "arretee", "interrompue", "plafond", "non-lancee", "non-choisi"] as const),
  "en-cours": Object.freeze(["attente-accord", "terminee", "echec", "arretee", "interrompue", "plafond"] as const),
  "attente-accord": Object.freeze(["en-cours", "terminee", "echec", "arretee", "interrompue", "plafond"] as const),
  terminee: Object.freeze([] as const),
  echec: Object.freeze([] as const),
  arretee: Object.freeze([] as const),
  interrompue: Object.freeze([] as const),
  plafond: Object.freeze([] as const),
  "non-lancee": Object.freeze([] as const),
  "non-choisi": Object.freeze([] as const),
});

/**
 * Transition permise. États lus en base (texte libre, sans contrainte) : un état inconnu n'a aucune transition ; un même état
 * n'est pas une transition (false).
 */
export function canTransition(kind: "run" | "step", from: string, to: string): boolean {
  const table: Readonly<Record<string, readonly string[]>> = kind === "run" ? TEAM_RUN_TRANSITIONS : TEAM_STEP_TRANSITIONS;
  if (!Object.hasOwn(table, from) || !Object.hasOwn(table, to)) return false;
  return (table[from] ?? []).includes(to);
}

// --- Ordre d'exécution et sémantique de `recoit` ------------------------------------------------------------------------------

/** Tours d'une relecture, bornés par FLOW_LIMITS.toursMax : un JSON non validé ne fait jamais lancer plus d'appels que la borne. */
export function toursDe(block: Extract<FlowBlock, { type: "relecture" }>): number {
  const brut = Math.trunc(Number(block.toursMax));
  if (!Number.isFinite(brut) || brut < 1) return 1;
  return Math.min(brut, FLOW_LIMITS.toursMax);
}

/** Spécialistes retenus au plus par un aiguillage, bornés par FLOW_LIMITS.choixMax et par le nombre de spécialistes proposés. */
export function choixMaxDe(block: Extract<FlowBlock, { type: "aiguillage" }>): number {
  const proposes = Array.isArray(block.specialistes) ? block.specialistes.length : 0;
  const brut = Math.trunc(Number(block.choixMax));
  const borne = !Number.isFinite(brut) || brut < 1 ? 1 : Math.min(brut, FLOW_LIMITS.choixMax);
  return Math.max(1, Math.min(borne, proposes));
}

/**
 * Étapes d'un bloc de travail dans l'ordre d'écriture, avec leur rôle : l'étape ; les avis puis la synthèse ; l'auteur puis le
 * relecteur ; l'aiguilleur, les spécialistes puis la synthèse. Une pause n'en a aucune. Un type de bloc inconnu (JSON non
 * validé) n'en a aucune non plus : validateFlow (L36a) le refuse avant tout lancement.
 */
function stepsOfBlock(block: FlowBlock): Array<{ step: FlowStep; role: PlannedOrder["role"] }> {
  switch (block.type) {
    case "etape":
      return [{ step: block.etape, role: "etape" }];
    case "avis":
      return [...block.avis.map((step) => ({ step, role: "avis" as const })), { step: block.synthese, role: "synthese" as const }];
    case "relecture":
      return [
        { step: block.auteur, role: "redaction" as const },
        { step: block.relecteur, role: "relecture" as const },
      ];
    case "aiguillage":
      return [
        { step: block.aiguilleur, role: "aiguilleur" as const },
        ...block.specialistes.map((step) => ({ step, role: "specialiste" as const })),
        ...(block.synthese ? [{ step: block.synthese, role: "synthese" as const }] : []),
      ];
    default:
      return [];
  }
}

/** Chemin demandé à planSteps : « typique » = le déroulé habituel, « maximal » (défaut) = tout ce que le plafond doit couvrir. */
export interface PlanOptions {
  chemin?: "typique" | "maximal";
}

/** Entrées d'un bloc « relecture » sur le chemin demandé (1 tour, ou 1 + 2 × toursMax appels : révision finale comprise). */
function relectureOrder(block: Extract<FlowBlock, { type: "relecture" }>, chemin: "typique" | "maximal"): Array<{ step: FlowStep; role: PlannedOrder["role"]; tour: number }> {
  const auteur = { step: block.auteur, role: "redaction" as const };
  const relecteur = { step: block.relecteur, role: "relecture" as const };
  if (chemin === "typique") return [{ ...auteur, tour: 1 }, { ...relecteur, tour: 1 }];
  const tours = toursDe(block);
  const out: Array<{ step: FlowStep; role: PlannedOrder["role"]; tour: number }> = [];
  for (let tour = 1; tour <= tours; tour++) {
    out.push({ ...auteur, tour });
    out.push({ ...relecteur, tour });
  }
  // Dernière révision : le relecteur a rendu « à reprendre » au dernier tour, l'auteur corrige une dernière fois (C §6.2).
  out.push({ ...auteur, tour: tours + 1 });
  return out;
}

/** Entrées d'un bloc « aiguillage » : un spécialiste sans synthèse sur le chemin typique, `choixMax` et la synthèse au maximal. */
function aiguillageOrder(block: Extract<FlowBlock, { type: "aiguillage" }>, chemin: "typique" | "maximal"): Array<{ step: FlowStep; role: PlannedOrder["role"]; tour: number }> {
  const specialistes = Array.isArray(block.specialistes) ? block.specialistes : [];
  const out: Array<{ step: FlowStep; role: PlannedOrder["role"]; tour: number }> = [{ step: block.aiguilleur, role: "aiguilleur", tour: 1 }];
  const retenus = chemin === "typique" ? specialistes.slice(0, 1) : specialistes.slice(0, choixMaxDe(block));
  for (const step of retenus) out.push({ step, role: "specialiste", tour: 1 });
  // La synthèse ne travaille qu'à partir de deux résultats choisis : le chemin typique (un seul spécialiste) la saute.
  if (block.synthese && chemin === "maximal" && retenus.length >= 2) out.push({ step: block.synthese, role: "synthese", tour: 1 });
  return out;
}

/**
 * Ordre d'exécution, de haut en bas : bloc « etape » → une entrée ; bloc « avis » → chaque avis (rôle « avis ») puis la synthèse
 * (rôle « synthese ») ; bloc « pause » → aucune entrée. Pour ces formes de l'itération 4, `tour` vaut 1 et les deux chemins sont
 * identiques (non-régression : `planSteps(flow)` rend exactement ce que rendait l'itération 4).
 * Formes de la 5b : une relecture donne 2 entrées sur le chemin typique et `1 + 2 × toursMax` sur le chemin maximal (une entrée
 * par tour, révision finale comprise) ; un aiguillage donne l'aiguilleur et un spécialiste sur le chemin typique, l'aiguilleur,
 * `choixMax` spécialistes et la synthèse sur le chemin maximal. Défaut : « maximal », le chemin que le plafond doit couvrir.
 */
export function planSteps(flow: Flow, options: PlanOptions = {}): PlannedOrder[] {
  const chemin = options.chemin ?? "maximal";
  const out: PlannedOrder[] = [];
  flow.blocs.forEach((block, blocIndex) => {
    const entrees =
      block.type === "relecture"
        ? relectureOrder(block, chemin)
        : block.type === "aiguillage"
          ? aiguillageOrder(block, chemin)
          : stepsOfBlock(block).map((entree) => ({ ...entree, tour: 1 }));
    for (const { step, role, tour } of entrees) {
      out.push({ stepId: step.id, blocId: block.id, blocIndex, ordre: out.length + 1, tour, role });
    }
  });
  return out;
}

/**
 * Étape(s) qui portent le RÉSULTAT d'un bloc de travail, c'est-à-dire ce que « precedent » transmet au bloc suivant : l'étape ;
 * la synthèse d'un bloc d'avis ; la dernière version de l'auteur d'une relecture (jamais la relecture elle-même) ; la synthèse
 * d'un aiguillage, ou, faute de synthèse, le spécialiste retenu — inconnu avant votre choix, donc tous les spécialistes ici.
 */
function blockResultSteps(block: FlowBlock): FlowStep[] {
  switch (block.type) {
    case "etape":
      return [block.etape];
    case "avis":
      return [block.synthese];
    case "relecture":
      return [block.auteur];
    case "aiguillage":
      return block.synthese ? [block.synthese] : Array.isArray(block.specialistes) ? block.specialistes : [];
    default:
      return [];
  }
}

/** Ordre de référence des étapes, sans doublon : premier passage de chaque étape sur le chemin maximal. */
function stepOrder(flow: Flow): string[] {
  const out: string[] = [];
  for (const planned of planSteps(flow)) if (!out.includes(planned.stepId)) out.push(planned.stepId);
  return out;
}

/**
 * Sémantique de `recoit` : identifiants des étapes dont l'étape reçoit le résultat, dans l'ordre de planSteps.
 * - « demande » → [] ;
 * - « precedent » → résultat du bloc de travail précédent (son étape, sa synthèse, sa dernière version) ; [] pour le premier ;
 * - « tous » → toutes les étapes des blocs de travail précédents, plus, pour la synthèse d'un bloc d'avis, les avis de son bloc ;
 * - `{etapes}` (5b) → EXACTEMENT les étapes listées, dans l'ordre de planSteps ; un identifiant inconnu du déroulé est ignoré
 *   (la grammaire le refuse par `lien-arriere` avant tout lancement).
 * Transmissions IMPLICITES des formes de la 5b, que `recoit` ne règle pas : le relecteur reçoit la version courante de l'auteur ;
 * un spécialiste reçoit la demande et la raison de l'aiguilleur ; la synthèse d'un aiguillage reçoit les résultats choisis (au
 * plus les spécialistes de son bloc).
 * Un avis ne reçoit jamais le résultat d'un autre avis. Étape inconnue du déroulé : RangeError ; valeur de `recoit` inconnue
 * (JSON non validé, refusé par validateFlow) : [], rien n'est transmis.
 */
export function receivedFrom(flow: Flow, stepId: string): string[] {
  const blocIndex = flow.blocs.findIndex((block) => stepsOfBlock(block).some(({ step }) => step.id === stepId));
  const block = flow.blocs[blocIndex];
  const own = block ? stepsOfBlock(block).find(({ step }) => step.id === stepId) : undefined;
  if (!block || !own) throw new RangeError(`receivedFrom : étape inconnue du déroulé (${stepId})`);

  // Transmissions implicites : elles ne se règlent pas dans l'éditeur, elles tiennent à la forme du bloc.
  if (block.type === "relecture" && own.role === "relecture") return [block.auteur.id];
  if (block.type === "aiguillage") {
    if (own.role === "specialiste") return [block.aiguilleur.id];
    if (own.role === "synthese") return (Array.isArray(block.specialistes) ? block.specialistes : []).map((step) => step.id);
  }

  // Blocs de travail au-dessus de celui de l'étape : les étapes de son propre bloc n'en font jamais partie.
  const earlier = flow.blocs.slice(0, blocIndex).filter((b) => stepsOfBlock(b).length > 0);
  const listees = stepInputEtapes(own.step.recoit);
  if (listees !== null) {
    const ordre = stepOrder(flow);
    return ordre.filter((id) => listees.includes(id));
  }
  switch (own.step.recoit) {
    case "demande":
      return [];
    case "precedent": {
      const previous = earlier.at(-1);
      return previous ? blockResultSteps(previous).map((step) => step.id) : [];
    }
    case "tous": {
      const before = earlier.flatMap((b) => stepsOfBlock(b).map(({ step }) => step.id));
      const siblings = own.role === "synthese" && block.type === "avis" ? block.avis.map((step) => step.id) : [];
      return [...before, ...siblings];
    }
    default:
      return [];
  }
}
