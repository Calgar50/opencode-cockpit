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
 * Bornes du déroulé. `blocsTravail` : blocs « etape » et « avis » (les pauses ne comptent pas) ; `etapes` : toutes les étapes,
 * avis et synthèses comprises ; `simultanees` : étapes lancées ensemble au plus (réglage teams.concurrentSteps, mode Avancé) ;
 * `relaisCaracteres` : résultat transmis à une étape ; `demande`, `fichiers`, `precision` : corps des routes de lancement.
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

export const FLOW_BLOCK_TYPES = membersOf<FlowBlock["type"]>({ etape: true, avis: true, pause: true });

export const STEP_INPUTS = membersOf<StepInput>({ demande: true, precedent: true, tous: true });

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
});

export const TEAM_RUN_STATES = membersOf<TeamRunState>({
  preparation: true,
  "en-cours": true,
  "attente-verification": true,
  "attente-budget": true,
  "attente-modification": true,
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
 */
export const TEAM_STEP_TRANSITIONS: TeamStepTransitions = Object.freeze({
  prevue: Object.freeze(["en-file", "en-cours", "echec", "non-lancee"] as const),
  "en-file": Object.freeze(["en-cours", "echec", "arretee", "interrompue", "plafond", "non-lancee"] as const),
  "en-cours": Object.freeze(["attente-accord", "terminee", "echec", "arretee", "interrompue", "plafond"] as const),
  "attente-accord": Object.freeze(["en-cours", "terminee", "echec", "arretee", "interrompue", "plafond"] as const),
  terminee: Object.freeze([] as const),
  echec: Object.freeze([] as const),
  arretee: Object.freeze([] as const),
  interrompue: Object.freeze([] as const),
  plafond: Object.freeze([] as const),
  "non-lancee": Object.freeze([] as const),
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

/**
 * Étapes d'un bloc de travail dans l'ordre d'exécution : l'étape, ou les avis puis la synthèse ; une pause n'en a aucune. Un
 * type de bloc inconnu (JSON non validé) n'en a aucune non plus : validateFlow (L36a) le refuse avant tout lancement.
 */
function stepsOfBlock(block: FlowBlock): Array<{ step: FlowStep; role: PlannedOrder["role"] }> {
  switch (block.type) {
    case "etape":
      return [{ step: block.etape, role: "etape" }];
    case "avis":
      return [...block.avis.map((step) => ({ step, role: "avis" as const })), { step: block.synthese, role: "synthese" as const }];
    default:
      return [];
  }
}

/**
 * Ordre d'exécution, de haut en bas : bloc « etape » → une entrée ; bloc « avis » → chaque avis (rôle « avis ») puis la
 * synthèse (rôle « synthese ») ; bloc « pause » → aucune entrée. `tour` = 1. En itération 4, le chemin typique est le chemin
 * maximal (aucun bloc facultatif ni aiguillage).
 */
export function planSteps(flow: Flow): PlannedOrder[] {
  const out: PlannedOrder[] = [];
  flow.blocs.forEach((block, blocIndex) => {
    for (const { step, role } of stepsOfBlock(block)) {
      out.push({ stepId: step.id, blocId: block.id, blocIndex, ordre: out.length + 1, tour: 1, role });
    }
  });
  return out;
}

/**
 * Sémantique de `recoit` : identifiants des étapes dont l'étape reçoit le résultat, dans l'ordre de planSteps.
 * - « demande » → [] ;
 * - « precedent » → résultat du bloc de travail précédent (son étape, ou sa synthèse pour un bloc d'avis) ; [] pour le premier ;
 * - « tous » → toutes les étapes des blocs de travail précédents, plus, pour la synthèse d'un bloc d'avis, les avis de son bloc.
 * Un avis ne reçoit jamais le résultat d'un autre avis. Étape inconnue du déroulé : RangeError ; valeur de `recoit` inconnue
 * (JSON non validé, refusé par validateFlow) : [], rien n'est transmis.
 */
export function receivedFrom(flow: Flow, stepId: string): string[] {
  const blocIndex = flow.blocs.findIndex((block) => stepsOfBlock(block).some(({ step }) => step.id === stepId));
  const block = flow.blocs[blocIndex];
  const own = block ? stepsOfBlock(block).find(({ step }) => step.id === stepId) : undefined;
  if (!block || !own) throw new RangeError(`receivedFrom : étape inconnue du déroulé (${stepId})`);
  // Blocs de travail au-dessus de celui de l'étape : les étapes de son propre bloc n'en font jamais partie.
  const earlier = flow.blocs.slice(0, blocIndex).filter((b) => stepsOfBlock(b).length > 0);
  switch (own.step.recoit) {
    case "demande":
      return [];
    case "precedent": {
      const previous = earlier.at(-1);
      const last = previous ? stepsOfBlock(previous).at(-1) : undefined;
      return last ? [last.step.id] : [];
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
