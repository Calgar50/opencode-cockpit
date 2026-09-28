// Règles d'autonomie (spécification §4.1, §4.3, §4.7, §4.8.1, §4.10, §4.11 ; décisions n° 4, 7, 9, 13 et 14 ; plan d'exécution,
// fiche L9b ; découpage D-02) : matrice des quatre choix (routePermission, allowJudge), pré-conditions d'un examen
// (preconditionFailure), délégation en Autonome D1 à D7 (classifyDelegation), refus d'activation (activationRefusal), plafonds
// d'une demande (capReached), version des règles (AUTONOMY_RULES_VERSION), codes des consultations automatiques de la porte des
// commandes (isShellConsultationRule) et réexport de la politique « modification » E1 à E6 (classifyEdit, paquet L9a). Rend des
// CODES seulement : les phrases sont écrites dans autonomy-texts.ts (même paquet).
//
// Matrice §4.1 et cycle §4.3, telles que ce module les applique :
// - « Demander à chaque fois » et « Plan d'abord » : aucun examen ; seule la garde des délégations (refus Simple, attente Avancé)
//   s'applique au travail délégué (L1d). « Plan d'abord » retire edit, write, apply_patch et bash par son plancher (L3).
// - « Modifications automatiques » : seul `edit` peut être automatique (§4.4) ; tout le reste attend, délégations comprises (garde).
// - « Autonome avec contrôle » : `edit` → §4.4, `bash` → §4.5 puis §4.6 si « à juger » (IA de contrôle seulement si
//   budget.autonomie.controleIa), `task` → §4.7, `skill` → automatique ; web, dossier hors projet, lecture demandée (.env),
//   répétition (doom_loop) et tout autre nom (MCP, extension, outil d'une version future) → attente.
// L'autonomie n'envoie jamais de refus, hors refus Simple d'une délégation (§4.3) : seul classifyDelegation rend « refus », et
// seulement en mode Simple.
//
// Module pur (server/shared) : ni module node ni accès au processus ; l'heure est passée par l'appelant (capReached) ; aucune
// entrée n'est modifiée. Les faits (règles de l'assistant, configuration, compteurs, faits d'une délégation) sont relevés par le
// serveur (L10a, L10c, L10d, L1d) et arrivent en données.
import { evaluate, type Rule, type UiMode, wildcardMatch } from "./assistant-rules.ts";
import type { ActivationRefusalCode, AutonomyCaps, AutonomyChoice, ChoiceCause, DelegationFacts, RequestEnd } from "./autonomy-types.ts";
import { GIT_CONSULTATION_SUBCOMMANDS } from "./shell-gate.ts";

export { classifyEdit, EDIT_AUTO_RULE, EDIT_RULE_ORDER, isProtectedPath, PROTECTED_GLOBS } from "./autonomy-edit-rules.ts";
export type { EditFacts, EditPathFacts, EditRule, EditVerdict } from "./autonomy-edit-rules.ts";

/**
 * Version des règles d'autonomie (D-02 ; « RULES_VERSION » est déjà celle des règles d'utilisation, assistant-rules.ts), écrite
 * dans autonomy_decisions.rules_version. À incrémenter à tout changement d'une règle qui décide : matrice et routes de ce module,
 * E1-E6 (autonomy-edit-rules.ts), S1-S7 (shell-gate.ts), D1-D7, plafonds.
 */
export const AUTONOMY_RULES_VERSION = 2;

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);

/** Entier sûr positif ou nul (Number.isSafeInteger ne convertit pas : une chaîne est refusée). */
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Nombre fini positif ou nul (Number.isFinite ne convertit pas : une chaîne est refusée). */
const isAmount = (value: unknown): value is number => Number.isFinite(value) && (value as number) >= 0;

// --- Matrice §4.1 et classement §4.3 ----------------------------------------------------------------------------------------

/** Attente décidée par la route seule (§4.3 étape 4, §4.1), sans examen de la demande. */
export type RouteWaitRule = "R-web" | "R-hors-projet" | "R-lecture" | "R-repetition" | "R-autre" | "R-modifications";

/** Code d'une décision automatique `skill` (§4.3 : automatique en Autonome). */
export const SKILL_AUTO_RULE = "A-skill";

/**
 * Suite d'une demande d'autorisation selon le choix de sa racine :
 * - hors-autonomie : choix « demander » ou « plan » ; aucun examen, la demande attend l'utilisateur ;
 * - garde-delegation : `task` hors Autonome ; garde des délégations et refus Simple (L1d), jamais une décision de l'autonomie ;
 * - edit, bash, task : examen par classifyEdit, classifyCommand (shell-gate.ts) puis l'IA de contrôle si « à juger »,
 *   classifyDelegation ;
 * - auto : automatique sans examen (`skill` en Autonome) ;
 * - attente : attente avec sa règle.
 */
export type PermissionRoute =
  | { route: "hors-autonomie" }
  | { route: "garde-delegation" }
  | { route: "edit" }
  | { route: "bash" }
  | { route: "task" }
  | { route: "auto"; regle: typeof SKILL_AUTO_RULE }
  | { route: "attente"; regle: RouteWaitRule };

/**
 * Permissions d'opencode 1.18.30 qui attendent toujours, quel que soit le choix (§4.1 : web, dossier hors projet, répétition ;
 * « Lire, chercher : selon l'assistant » : une lecture n'est demandée que si l'assistant le veut, par exemple un `.env`).
 */
const WAIT_BY_PERMISSION: ReadonlyMap<string, RouteWaitRule> = new Map<string, RouteWaitRule>([
  ["webfetch", "R-web"],
  ["websearch", "R-web"],
  ["external_directory", "R-hors-projet"],
  ["read", "R-lecture"],
  ["glob", "R-lecture"],
  ["grep", "R-lecture"],
  ["list", "R-lecture"],
  ["doom_loop", "R-repetition"],
]);

/** Permissions examinées en Autonome ; en « Modifications automatiques », elles attendent (seul `edit` y est automatique). */
const EXAMINED_IN_AUTONOMY: ReadonlySet<string> = new Set(["bash", "skill"]);

/**
 * Route d'une demande d'autorisation (§4.3 étapes 2 et 4, matrice §4.1). `permission` est le nom exact envoyé par opencode :
 * les trois outils de modification demandent tous `edit` en 1.18.30 (mesure MX1) ; un autre nom (« write », « apply_patch »
 * d'une version future, outil MCP ou d'extension) attend. Un choix inconnu n'est jamais examiné.
 */
export function routePermission(choice: AutonomyChoice, permission: string): PermissionRoute {
  if (permission === "task") return choice === "autonome" ? { route: "task" } : { route: "garde-delegation" };
  if (choice !== "modifications" && choice !== "autonome") return { route: "hors-autonomie" };
  if (permission === "edit") return { route: "edit" };
  const wait = WAIT_BY_PERMISSION.get(permission);
  if (wait !== undefined) return { route: "attente", regle: wait };
  if (!EXAMINED_IN_AUTONOMY.has(permission)) return { route: "attente", regle: "R-autre" };
  if (choice === "modifications") return { route: "attente", regle: "R-modifications" };
  return permission === "bash" ? { route: "bash" } : { route: "auto", regle: SKILL_AUTO_RULE };
}

/**
 * Programmes de consultation de la porte des commandes, hors `find` et `git` (§4.5, S3 ; clés de SIMPLE_COMMANDS dans
 * shell-gate.ts, liste vérifiée contre son source par autonomy-rules.test.ts).
 */
export const SHELL_CONSULTATION_PROGRAMS = Object.freeze(["pwd", "ls", "cat", "head", "tail", "wc", "stat", "du", "grep", "rg"] as const);

/** Codes des consultations automatiques rendus par classifyCommand (S3) : A-<programme>, A-find, A-git-<sous-commande>. */
export const SHELL_CONSULTATION_RULES: readonly string[] = Object.freeze([
  ...SHELL_CONSULTATION_PROGRAMS.map((program) => `A-${program}`),
  "A-find",
  ...GIT_CONSULTATION_SUBCOMMANDS.map((sub) => `A-git-${sub}`),
]);

const CONSULTATION_RULES: ReadonlySet<unknown> = new Set(SHELL_CONSULTATION_RULES);

/**
 * Vrai si `code` est une consultation automatique de la porte des commandes. Liste fermée : un autre code « A-… » (d'une version
 * plus récente ou d'un autre module) n'est jamais présenté comme une consultation.
 */
export function isShellConsultationRule(code: unknown): boolean {
  return CONSULTATION_RULES.has(code);
}

/**
 * `allowJudge` de la porte des commandes (shell-gate.ts) : un programme non listé est soumis à l'IA de contrôle seulement en
 * « Autonome avec contrôle » avec budget.autonomie.controleIa (§4.6) ; sinon il attend votre accord (repli §7.4).
 */
export function allowJudge(choice: AutonomyChoice, controleIa: boolean): boolean {
  return choice === "autonome" && controleIa === true;
}

// --- Pré-conditions d'un examen (§4.3 étape 3) -------------------------------------------------------------------------------

/** Pré-condition d'un examen qui échoue : la demande attend, avec cette règle (X-illisible : une donnée ne se lit pas). */
export type PreconditionRule = "X-coupee" | "X-hors-demande" | "X-illisible";

export interface PreconditionInput {
  /** COCKPIT_AUTONOMY. */
  interrupteur: boolean;
  /** Une demande autonome est en cours pour la racine (autonomy_requests). */
  demandeEnCours: boolean;
  /** Plafond atteint (capReached), null sinon. */
  plafond: CapHit | null;
  /** Activation revérifiée (activationRefusal), null si elle tient toujours. */
  activation: ActivationRefusalCode | null;
}

/** Tous les codes de refus d'activation (autonomy-types.ts), liste exhaustive vérifiée par le typage. */
export const ACTIVATION_REFUSAL_CODES: readonly ActivationRefusalCode[] = Object.freeze(
  Object.keys({
    "a-venir": true,
    "autonomie-coupee": true,
    "regle-allow": true,
    "mcp-ou-extension": true,
    "profil-sans-confirmation": true,
    "plancher-non-verifie": true,
    "racine-de-plan": true,
    "nouvelle-conversation": true,
  } satisfies Record<ActivationRefusalCode, true>) as ActivationRefusalCode[],
);

const ACTIVATION_CODES: ReadonlySet<unknown> = new Set(ACTIVATION_REFUSAL_CODES);

/** Vrai si `code` est un code de refus d'activation connu. */
export function isActivationRefusalCode(code: unknown): code is ActivationRefusalCode {
  return ACTIVATION_CODES.has(code);
}

/**
 * Première pré-condition qui échoue, dans l'ordre du §4.3 étape 3 : interrupteur, demande en cours, plafonds, activation. Rend
 * la règle de l'attente (X-coupee, X-hors-demande, cause du plafond atteint ou code du refus d'activation), null si l'examen peut
 * avoir lieu. Toute valeur illisible (absente, d'un autre type, code inconnu) échoue en X-illisible : jamais d'examen par défaut.
 */
export function preconditionFailure(input: PreconditionInput): PreconditionRule | CapHit["cause"] | ActivationRefusalCode | null {
  if (!isRecord(input)) return "X-illisible";
  if (input.interrupteur === false) return "X-coupee";
  if (input.interrupteur !== true) return "X-illisible";
  if (input.demandeEnCours === false) return "X-hors-demande";
  if (input.demandeEnCours !== true) return "X-illisible";
  if (input.plafond !== null) {
    const cause = isRecord(input.plafond) ? own(input.plafond, "cause") : undefined;
    return Object.values(CAP_HITS).find((hit) => hit.cause === cause)?.cause ?? "X-illisible";
  }
  if (input.activation === null) return null;
  return isActivationRefusalCode(input.activation) ? input.activation : "X-illisible";
}

/**
 * Règles d'attente dont la cause est l'ÉTAT DU COCKPIT et non l'action demandée : une relecture de `GET /permission` peut les
 * reprendre (§4.3 étape 8), car leur cause disparaît sans aucun nouvel événement de la demande — demande autonome ouverte
 * (X-hors-demande), interrupteur remis (X-coupee), compteurs d'une nouvelle demande (plafond-*), passage à « Autonome avec
 * contrôle » (R-modifications). Toutes les autres attentes (E1-E6, S1-S7, D1-D7, R-web, R-hors-projet, R-lecture, R-repetition,
 * R-autre, X-illisible, refus d'activation, relais déjà répondu) seraient redécidées à l'identique : elles ne sont jamais reprises.
 * Cette liste ne change AUCUNE décision : elle dit seulement ce qu'une relecture réexamine (pas de AUTONOMY_RULES_VERSION à lever).
 */
export const REPRISE_POSSIBLE: ReadonlySet<string> = new Set<PreconditionRule | CapHit["cause"] | RouteWaitRule>([
  "X-coupee",
  "X-hors-demande",
  "plafond-cout",
  "plafond-actions",
  "plafond-duree",
  "plafond-fichiers",
  "R-modifications",
]);

// --- Délégation en Autonome (§4.7) -------------------------------------------------------------------------------------------

export type DelegationRule = "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "D7";

/** Code d'une délégation automatique (famille « A- » des décisions automatiques). */
export const DELEGATION_AUTO_RULE = "A-task";

/**
 * Verdict d'une délégation en Autonome : automatique, ou la première règle qui échoue. Hors plafonds : refus en mode Simple
 * (l'IA continue seule, décision n° 4), attente en mode Avancé (carte détaillée). Forme compatible avec DelegationPolicyVerdict
 * (contracts-11.ts, port du paquet L10e).
 */
export type DelegationVerdict = { verdict: "auto"; regle: typeof DELEGATION_AUTO_RULE } | { verdict: "attente" | "refus"; regle: DelegationRule };

/** Modes d'un agent qui peut recevoir du travail délégué (opencode : « subagent » et « all » ; « primary » exclu, D1). */
const DELEGATION_TARGET_MODES: ReadonlySet<unknown> = new Set(["subagent", "all"]);

/** Faits relus propriété par propriété : une clé héritée du prototype n'est jamais lue. */
function own(record: JsonRecord, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

type DelegationCheck = (facts: JsonRecord, caps: JsonRecord) => boolean;

/**
 * Règles dans l'ordre du §4.7 ; chacune rend vrai quand la délégation peut rester automatique. D1 (pré-publication 1.1.0) exige
 * aussi que la cible ne lise pas un .env sans demander et n'agisse pas sans demander (targetRightsFacts) : son travail ne passe par
 * aucune demande, donc par aucun contrôle du cockpit (§4.1 « Lire un .env : votre accord », pour la conversation et tout son travail
 * délégué). Fait absent ou d'un autre type : D1.
 */
const DELEGATION_CHECKS: ReadonlyArray<readonly [DelegationRule, DelegationCheck]> = [
  [
    "D1",
    (facts) => {
      const target = own(facts, "target");
      if (!isRecord(target)) return false;
      const name = own(target, "name");
      return (
        typeof name === "string" &&
        name !== "" &&
        DELEGATION_TARGET_MODES.has(own(target, "mode")) &&
        own(target, "internal") === false &&
        own(target, "actsWithoutAsking") === false &&
        own(target, "readsEnvWithoutAsking") === false
      );
    },
  ],
  [
    "D2",
    (facts) => {
      const inTree = own(facts, "taskIdInTree");
      return inTree === null || inTree === true;
    },
  ],
  ["D3", (facts) => own(facts, "promptRisk") === null],
  ["D4", (facts) => own(facts, "modelAllowed") === true],
  ["D5", (facts) => own(facts, "guardAccepts") === true],
  [
    "D6",
    (facts, caps) => {
      const soFar = own(facts, "delegationsSoFar");
      const max = own(caps, "delegationsMax");
      return isCount(soFar) && isCount(max) && soFar < max;
    },
  ],
  [
    "D7",
    (facts) => {
      const estimate = own(facts, "estimateUsd");
      const remaining = own(facts, "remainingUsd");
      return isAmount(estimate) && Number.isFinite(remaining) && estimate <= (remaining as number);
    },
  ],
];

/** Ordre d'examen des règles D (§4.7), tel que classifyDelegation l'applique. */
export const DELEGATION_RULE_ORDER: readonly DelegationRule[] = Object.freeze(DELEGATION_CHECKS.map(([rule]) => rule));

/**
 * Délégation `task` en « Autonome avec contrôle » (§4.7) : `once` automatique seulement si D1 à D7 tiennent (la garde §3.14 est
 * passée avant, par le relais). Sinon la première règle qui échoue décide : refus en mode Simple, attente en mode Avancé ; un mode
 * illisible attend (jamais de refus envoyé sans certitude). Faits illisibles : D1.
 */
export function classifyDelegation(facts: DelegationFacts, caps: AutonomyCaps, mode: UiMode): DelegationVerdict {
  const factsRecord: JsonRecord = isRecord(facts) ? facts : {};
  const capsRecord: JsonRecord = isRecord(caps) ? caps : {};
  for (const [rule, holds] of DELEGATION_CHECKS) {
    if (holds(factsRecord, capsRecord)) continue;
    return { verdict: mode === "simple" ? "refus" : "attente", regle: rule };
  }
  return { verdict: "auto", regle: DELEGATION_AUTO_RULE };
}

// --- Activation (§4.10, §4.11) -------------------------------------------------------------------------------------------------

/**
 * Permissions qui, sur « allow » pour l'assistant, rendent l'activation impossible (§4.10 : le contrôle ne verrait pas ces
 * actions). `bash` avec le motif exact « pwd » (profil Prudent livré) est l'exception de la spécification.
 */
export const ACTIVATION_WATCHED_PERMISSIONS = Object.freeze(["edit", "bash", "task", "webfetch", "websearch"] as const);
export type ActivationWatchedPermission = (typeof ACTIVATION_WATCHED_PERMISSIONS)[number];

const ACTIONS: ReadonlySet<unknown> = new Set(["allow", "ask", "deny"]);

function isRule(value: unknown): value is Rule {
  return isRecord(value) && typeof own(value, "permission") === "string" && typeof own(value, "pattern") === "string" && ACTIONS.has(own(value, "action"));
}

/**
 * Vrai si l'assistant peut agir sur `permission` sans demande pour au moins une entrée. opencode garde la DERNIÈRE règle qui
 * correspond (evaluate, assistant-rules.ts) : une règle « allow » compte tant qu'aucune règle postérieure de motif « * » sur cette
 * permission (qui correspond à toute entrée) ne la recouvre. Un motif large autre que « * » ne recouvre rien ici : lecture
 * prudente, qui peut refuser plus que nécessaire, jamais moins.
 */
function allowsWithoutAsking(rules: readonly Rule[], permission: ActivationWatchedPermission): boolean {
  const applicable = rules.filter((rule) => wildcardMatch(permission, rule.permission));
  const lastCatchAll = applicable.findLastIndex((rule) => rule.pattern === "*");
  return applicable.some(
    (rule, index) => index >= lastCatchAll && rule.action === "allow" && !(permission === "bash" && rule.pattern === "pwd"),
  );
}

/**
 * Première permission surveillée que l'assistant exerce sans demander (§4.10), « regles-illisibles » si les règles ne se lisent pas
 * (absentes, pas un tableau, une règle mal formée), null si aucune.
 */
export function actsWithoutAsking(rules: readonly Rule[] | null): ActivationWatchedPermission | "regles-illisibles" | null {
  if (!Array.isArray(rules) || !rules.every(isRule)) return "regles-illisibles";
  return ACTIVATION_WATCHED_PERMISSIONS.find((permission) => allowsWithoutAsking(rules, permission)) ?? null;
}

/**
 * Chemins relatifs qu'opencode 1.18.30 passe à `read` pour des .env (tool/read.ts : motif = chemin relatif au dossier) : à la racine,
 * dans un sous-dossier, et leurs variantes. Les défauts d'opencode les mettent à « ask » ; une règle « read » posée après eux les
 * rouvre.
 */
export const ENV_READ_SAMPLES = Object.freeze([".env", "app/.env", ".env.local", "app/.env.production"] as const);

/**
 * Droits effectifs d'une cible de délégation (règles de GET /agent, dans l'ordre ; pré-publication 1.1.0, D1) :
 * - actsWithoutAsking : elle modifie, lance une commande, délègue ou va sur le web sans demander (même lecture que l'activation) ;
 * - readsEnvWithoutAsking : `read` d'un .env vaut « allow » (evaluate, la dernière règle l'emporte).
 * Règles illisibles : les deux à vrai (fermé en cas de doute). Le plancher de la conversation n'y est pas ajouté : il ne pose que
 * des refus, donc cette lecture peut refuser plus que nécessaire, jamais moins.
 */
export function targetRightsFacts(rules: readonly Rule[] | null): { actsWithoutAsking: boolean; readsEnvWithoutAsking: boolean } {
  if (!Array.isArray(rules) || !rules.every(isRule)) return { actsWithoutAsking: true, readsEnvWithoutAsking: true };
  return {
    actsWithoutAsking: actsWithoutAsking(rules) !== null,
    readsEnvWithoutAsking: ENV_READ_SAMPLES.some((file) => evaluate(rules, "read", file) === "allow"),
  };
}

/** Faits d'une activation, relevés par le serveur (L10d) ; tout booléen attendu qui n'est pas exactement la valeur sûre refuse. */
export interface ActivationFacts {
  /** COCKPIT_AUTONOMY (décision n° 13). */
  interrupteur: boolean;
  /** ACTIVATION_OUVERTE (porte I1, wiring-11.ts). */
  activationOuverte: boolean;
  /** Règles effectives de l'assistant de la conversation (GET /agent, dans l'ordre) ; null : illisibles. */
  agentRules: readonly Rule[] | null;
  /** La configuration effective d'opencode déclare `mcp` ou `plugin` (vrai aussi si elle n'a pas pu être lue). */
  mcpOuExtension: boolean;
  /** Profil global « Sans confirmation (déconseillé) » actif (vrai aussi s'il n'a pas pu être vérifié). */
  profilSansConfirmation: boolean;
  /** Plancher de conversation vérifié (§3.4). */
  plancherVerifie: boolean;
}

/**
 * Refus d'activation d'un choix automatique (§4.11, décision n° 14), réévalué à chaque envoi, dans l'ordre : interrupteur coupé,
 * activation fermée (« a-venir » : phrase fixée par autonomy-types.ts), assistant qui agit déjà sans demander (règles illisibles
 * comprises), MCP ou extension configurés, profil « Sans confirmation » actif, plancher non vérifié. null : activation permise.
 */
export function activationRefusal(input: ActivationFacts): ActivationRefusalCode | null {
  if (!isRecord(input) || input.interrupteur !== true) return "autonomie-coupee";
  if (input.activationOuverte !== true) return "a-venir";
  if (actsWithoutAsking(input.agentRules) !== null) return "regle-allow";
  if (input.mcpOuExtension !== false) return "mcp-ou-extension";
  if (input.profilSansConfirmation !== false) return "profil-sans-confirmation";
  if (input.plancherVerifie !== true) return "plancher-non-verifie";
  return null;
}

// --- Plafonds d'une demande (§4.8.1) -------------------------------------------------------------------------------------------

/** Plafonds vérifiés avant chaque décision ; délégations (D6) et contrôles IA (controlAi) sont bornés à leur propre décision. */
export type CapName = "cout" | "actions" | "duree" | "fichiers";

/** Plafond atteint : coût → arrêt de l'arbre (stopTree) ; les autres → retour à « Demander à chaque fois » (décision n° 9). */
export interface CapHit {
  plafond: CapName;
  effet: "arret" | "retour";
  fin: Extract<RequestEnd, "plafond-cout" | "plafond-actions" | "plafond-duree" | "plafond-fichiers">;
  cause: Extract<ChoiceCause, "plafond-cout" | "plafond-actions" | "plafond-duree" | "plafond-fichiers">;
}

/** Compteurs d'une demande autonome (autonomy_requests, L10a). */
export interface RequestCounters {
  /** Début de la demande, en millisecondes. */
  startedAt: number;
  /** Dépense de l'arbre depuis le début de la demande (ledger.spentSince), en dollars. */
  spentUsd: number;
  /** Décisions automatiques de la demande. */
  auto: number;
  /** Fichiers distincts modifiés automatiquement par la demande. */
  fichiers: number;
}

const MINUTE_MS = 60_000;

const CAP_HITS: Readonly<Record<CapName, CapHit>> = Object.freeze({
  cout: Object.freeze({ plafond: "cout", effet: "arret", fin: "plafond-cout", cause: "plafond-cout" }),
  actions: Object.freeze({ plafond: "actions", effet: "retour", fin: "plafond-actions", cause: "plafond-actions" }),
  duree: Object.freeze({ plafond: "duree", effet: "retour", fin: "plafond-duree", cause: "plafond-duree" }),
  fichiers: Object.freeze({ plafond: "fichiers", effet: "retour", fin: "plafond-fichiers", cause: "plafond-fichiers" }),
});

/**
 * Plafonds dans l'ordre de gravité : le coût (arrêt) d'abord, puis actions, durée et fichiers (§4.8.1). Un plafond à 0, hors des
 * bornes des réglages (settings.ts), n'est pas traité à part : la comparaison le donne atteint (coût, actions, durée), et E5 retient
 * tout fichier nouveau (fichiers).
 */
const CAP_CHECKS: ReadonlyArray<readonly [CapName, (counters: JsonRecord, caps: JsonRecord, now: number) => boolean]> = [
  [
    "cout",
    (counters, caps) => {
      const spent = own(counters, "spentUsd");
      const cap = own(caps, "plafondUsd");
      return !isAmount(spent) || !isAmount(cap) || spent >= cap;
    },
  ],
  [
    "actions",
    (counters, caps) => {
      const auto = own(counters, "auto");
      const cap = own(caps, "actionsMax");
      return !isCount(auto) || !isCount(cap) || auto >= cap;
    },
  ],
  [
    "duree",
    (counters, caps, now) => {
      const startedAt = own(counters, "startedAt");
      const minutes = own(caps, "dureeMinutes");
      if (!isAmount(startedAt) || !isCount(minutes) || !Number.isFinite(now)) return true;
      return now - startedAt >= minutes * MINUTE_MS;
    },
  ],
  [
    // E5 (classifyEdit) retient chaque fichier nouveau au-delà du plafond : les fichiers déjà comptés restent modifiables jusqu'au
    // plafond compris. Ici, seul un compte qui le DÉPASSE (ou illisible) arrête l'autonomie.
    "fichiers",
    (counters, caps) => {
      const files = own(counters, "fichiers");
      const cap = own(caps, "fichiersMax");
      return !isCount(files) || !isCount(cap) || files > cap;
    },
  ],
];

/** Ordre de vérification des plafonds, tel que capReached l'applique. */
export const CAP_ORDER: readonly CapName[] = Object.freeze(CAP_CHECKS.map(([cap]) => cap));

/**
 * Premier plafond atteint d'une demande (§4.8.1), ou null. `now` est l'heure de l'appelant (horloge injectable, jamais lue ici).
 * Coût : dépense ≥ plafond → arrêt. Actions : décisions automatiques ≥ plafond (la suivante ne l'est plus) → retour. Durée :
 * écoulée ≥ plafond → retour. Fichiers : compte > plafond → retour. Compteur, plafond ou heure illisible : plafond atteint.
 */
export function capReached(counters: RequestCounters, caps: AutonomyCaps, now: number): CapHit | null {
  const countersRecord: JsonRecord = isRecord(counters) ? counters : {};
  const capsRecord: JsonRecord = isRecord(caps) ? caps : {};
  for (const [cap, reached] of CAP_CHECKS) {
    if (reached(countersRecord, capsRecord, now)) return CAP_HITS[cap];
  }
  return null;
}
