// Contrat de l'API 0.2.0 « Assistants et niveaux d'IA » : TYPES UNIQUEMENT (aucun code exécuté).
// Le serveur type ses réponses avec (`satisfies`), l'interface les réexporte depuis web/lib/types.ts.
// Détail des routes, codes d'erreur et messages : scratchpad/impl/CONTRACT.md.
import type {
  AssistantDraft,
  AssistantIcon,
  Estimate,
  ModelRef,
  RightLine,
  RightsLabel,
  Run,
  TaskSize,
  Tier,
  TierDefs,
  TierStatus,
  Turn,
  TurnDisplay,
  UiMode,
  UseCase,
} from "./assistant-rules.ts";

export interface IssueLite {
  path: string;
  message: string;
}

export type ItemKind = "agents" | "commands";
export type AssistantOrigin = "assistant" | "catalogue" | "adopte" | "studio";

/** État d'un assistant dont le fichier existe. */
export type AssistantState = "ok" | "mise-a-jour" | "ia-indisponible" | "modifie-hors-cockpit";

/** Estimation prête à afficher. */
export interface EstimateView extends Estimate {
  /** « ≈ 0,18 $ par demande » */
  text: string;
  /** « ≈ 0,18 $ par demande (estimation) » ou « … (moyenne de vos 12 dernières demandes) » */
  detailText: string;
}

// --- Paramètres (sections ajoutées) -----------------------------------------------------

export interface AiSettings {
  /** null = recommandation livrée avec le cockpit (DEFAULT_TIERS). */
  tiers: TierDefs | null;
  chatDefaultTier: Tier;
  allowModelOverride: boolean;
}

export interface UiSettings {
  mode: UiMode;
  rulesAcceptedVersion: number;
  /** Version (ex. « 0.2.0 ») dont la notice unique a été vue, sinon null. */
  noticeSeen: string | null;
}

// --- Assistants --------------------------------------------------------------------------

/** Élément lié à un niveau dont le fichier n'utilise plus l'IA résolue du niveau. */
export interface UpdateItem {
  kind: ItemKind;
  name: string;
  /** Titre de l'assistant, sinon « /nom » pour un raccourci, sinon le nom. */
  title: string;
  tier: Tier;
  from: string | null;
  fromName: string | null;
  to: string;
  toName: string;
  /** Réflexion qui sera écrite (null : aucune). */
  variant: string | null;
  fromUsd: number | null;
  toUsd: number | null;
  /** toUsd / fromUsd (≥ 2 : ton « danger »), null si inconnu. */
  ratio: number | null;
}

export interface AssistantView {
  /** Nom technique = nom du fichier agents/<name>.md. */
  name: string;
  title: string;
  description: string;
  useCase: UseCase | null;
  icon: AssistantIcon | null;
  origin: AssistantOrigin;
  catalogId: string | null;
  catalogVersion: number | null;
  /** null = IA précise (ou aucune). */
  tier: Tier | null;
  taskSize: TaskSize;
  /** Recalculé à la lecture du fichier (detectRights). */
  rights: RightsLabel;
  web: boolean;
  fiches: string[];
  examples: string[];
  /** Consignes sans le bloc de règles communes (stripCommonRules). */
  instructions: string;
  /** `model:` du fichier. */
  model: string | null;
  modelName: string | null;
  variant: string | null;
  variantLabel: string;
  steps: number | null;
  appliedModel: string | null;
  appliedVariant: string | null;
  state: AssistantState;
  /** Présent quand state === "mise-a-jour". */
  update: UpdateItem | null;
  estimate: EstimateView | null;
  /** Prix de sortie effectif au-delà du seuil du garde-fou. */
  expensive: boolean;
  /** Note « IA chère : … » (expensiveGuardNote) ou null. */
  guardNote: string | null;
  rightLines: RightLine[];
  /** true : lignes calculées sur les règles effectives de GET /agent ; false : sur le fichier (repli). */
  effectiveRules: boolean;
  /** Raccourcis qui utilisent cet assistant (agent: <name>). */
  usedBy: string[];
  mode: "primary" | "subagent" | "all";
  hidden: boolean;
  /** Chemin relatif au dossier de configuration (affichage). */
  file: string;
  updatedAt: number;
}

export interface SavedAssistant extends AssistantView {
  /** Règles lues dans GET /agent après enregistrement ≠ aperçu : afficher l'avertissement. */
  rulesDiffer: boolean;
}

export interface BuiltinAssistantView {
  name: "build" | "plan";
  title: string;
  help: string;
  /** Niveau des nouvelles conversations (ai.chatDefaultTier). */
  tier: Tier;
  model: string | null;
  modelName: string | null;
  rightLines: RightLine[];
  effectiveRules: boolean;
  estimate: EstimateView | null;
}

/** Agent principal visible créé avant 0.2 (sans ligne item_meta titrée) : « À compléter ». */
export interface ToCompleteItem {
  name: string;
  description: string;
  mode: "primary" | "all";
  model: string | null;
  modelName: string | null;
  variant: string | null;
  /** Niveau déduit quand le modèle est l'IA résolue d'un niveau. */
  inferredTier: Tier | null;
  rights: RightsLabel;
  rightLines: RightLine[];
}

/** Ligne item_meta dont le fichier est introuvable (jamais purgée automatiquement). */
export interface MissingItem {
  kind: ItemKind;
  name: string;
  title: string | null;
  tier: Tier | null;
}

export interface AssistantsResponse {
  assistants: AssistantView[];
  builtins: BuiltinAssistantView[];
  toComplete: ToCompleteItem[];
  updates: UpdateItem[];
  missing: MissingItem[];
}

export interface CatalogueItem {
  id: string;
  version: number;
  title: string;
  description: string;
  useCase: UseCase;
  icon: AssistantIcon;
  rights: "lecture" | "propose";
  web: boolean;
  tier: Tier;
  taskSize: TaskSize;
  fiches: string[];
  examples: string[];
  instructions: string;
  installed: boolean;
  /** Nom de l'assistant installé depuis cette entrée. */
  installedName: string | null;
  /** Fiches absentes du disque que l'installation créera. */
  newFiches: string[];
  model: string | null;
  modelName: string | null;
  tierStatus: TierStatus;
  estimate: EstimateView | null;
  expensive: boolean;
  rightLines: RightLine[];
  /** « Exemple à relire avec votre équipe » */
  review: string;
}

export interface InstallRequest {
  name?: string;
}

export interface AssistantSaveRequest extends AssistantDraft {
  /** Nom actuel lors d'une modification (renommage si différent). */
  previousName?: string | null;
}

export interface AssistantPreview {
  name: string;
  frontmatter: Record<string, unknown>;
  body: string;
  /** Fichier complet tel qu'il sera écrit (« Voir le fichier généré », Avancé). */
  file: string;
  rightLines: RightLine[];
  model: string | null;
  modelName: string | null;
  variant: string | null;
  status: TierStatus;
  estimate: EstimateView | null;
  guardNote: string | null;
  /** Erreurs bloquantes (zod, IA non autorisée ou absente…). Vide = enregistrable. */
  issues: IssueLite[];
  /** Avertissements non bloquants (IA de secours, réflexion retirée…). */
  warnings: string[];
}

export interface AdoptRequest {
  title: string;
  useCase: UseCase;
  taskSize: TaskSize;
}

export interface UsedByError {
  error: "used-by";
  message: string;
  commands: string[];
}

export interface FicheInfo {
  name: string;
  description: string;
}

// --- Niveaux d'IA ------------------------------------------------------------------------

export interface TierView {
  id: Tier;
  label: string;
  help: string;
  /** Définition en vigueur (réglage personnalisé ou recommandation). */
  candidates: string[];
  configuredVariant: string | null;
  /** Premier candidat (IA prévue). */
  plannedModel: string | null;
  plannedName: string | null;
  /** IA résolue (null si indisponible). */
  model: string | null;
  modelName: string | null;
  status: TierStatus;
  statusLabel: string;
  statusHelp: string | null;
  /** Réflexion appliquée (après vérification). */
  variant: string | null;
  variantLabel: string;
  /** « {prévue} n'est pas proposée par votre abonnement : {secours} est utilisée. » */
  fallbackText: string | null;
  warnings: string[];
  taskCost: { S: number; M: number; L: number } | null;
  /** « ≈ 0,18 $ par demande » à la taille M. */
  estimateText: string | null;
  expensive: boolean;
}

export type UsageRowType = "assistant" | "raccourci" | "agent" | "integre";
export type UsageRowState = "a-jour" | "mise-a-jour" | "modifie-hors-cockpit" | "a-ranger" | "introuvable" | "aucun";

export interface UsageRow {
  kind: ItemKind | "builtin";
  name: string;
  /** Titre, « /nom » ou « Assistant général ». */
  label: string;
  type: UsageRowType;
  /** « Assistant », « Raccourci », « Agent », « Intégré ». */
  typeLabel: string;
  tier: Tier | null;
  model: string | null;
  /** « Équilibré », « IA de l'assistant délégué », « IA précise (gpt-5.5) », « Niveau de la conversation ». */
  levelText: string;
  state: UsageRowState;
  /** « À jour », « Mise à jour disponible », « Modifié hors du cockpit », « À ranger », « Fichier introuvable », « — ». */
  stateText: string;
  /** true : agent listé dans « À compléter » de la page Assistants (seul endroit où le mode Simple peut le ranger). */
  completable: boolean;
}

export interface AiView {
  source: "recommandation" | "personnalise";
  /** « Recommandation livrée avec le cockpit 0.2.0 » ou « Réglage personnalisé ». */
  sourceText: string;
  tiers: TierView[];
  chatDefaultTier: Tier;
  allowModelOverride: boolean;
  usage: UsageRow[];
  updates: UpdateItem[];
}

export interface PutTiersRequest {
  tiers: TierDefs | null;
}

export interface PutTiersResponse {
  /** Éléments liés qui passeraient à une autre IA (aucun fichier réécrit). */
  impacted: UpdateItem[];
  ai: AiView;
}

export interface RealignRequest {
  /** Absent = tous les éléments « Mise à jour disponible ». */
  items?: Array<{ kind: ItemKind; name: string }>;
}

export interface RealignResponse {
  updated: UpdateItem[];
}

/** POST /api/ai/keep-model (deux modes) : « Garder cette IA précise », aucun fichier réécrit. */
export interface KeepModelRequest {
  kind: ItemKind;
  name: string;
}

export interface KeepModelResponse {
  kind: ItemKind;
  name: string;
  /** IA du fichier, désormais retenue (plus liée à un niveau). */
  model: string | null;
  variant: string | null;
}

// --- Chat --------------------------------------------------------------------------------

export interface ResolveRequest {
  directory: string;
  agent: string;
  /** Niveau choisi pour un agent sans IA propre (défaut : ai.chatDefaultTier). */
  tier?: Tier;
  /** Réflexion choisie pour le niveau (null : standard). */
  variant?: string | null;
  /** « Autre IA… » (mode Avancé). */
  override?: ModelRef & { variant?: string };
  /** Nom du raccourci sans « / ». */
  command?: string;
}

export interface ResolveResponse extends Turn {
  /** Agent réellement utilisé (repli sur l'agent par défaut s'il est inconnu). */
  agent: string;
  agentTitle: string;
  /** Nom demandé mais inconnu (toast « Assistant introuvable »), sinon null. */
  agentMissing: string | null;
  tier: Tier | null;
  tierStatus: TierStatus | null;
  command: string | null;
  delegated: boolean;
  /** « fournisseur/modèle » de send.model (corps de /command). */
  bodyModel: string;
  display: TurnDisplay;
}

export type ChatTurnKind = "message" | "raccourci" | "resume";

export type ChoicesResponse = {
  agent: string;
  tier: Tier | null;
  model: string | null;
  variant: string | null;
  createdAt: number;
} | null;

/** 409 du proxy sur prompt_async : l'IA de l'assistant a changé, renvoyer une fois avec ce modèle. */
export interface AssistantModelChangedError {
  error: "assistant-model-changed";
  message: string;
  agent: string;
  model: ModelRef;
  variant: string | null;
  modelName: string;
}

/** 409 du garde-fou budgétaire (proxy), étendu aux appels réellement facturés. */
export interface BudgetGuardError {
  error: "budget-guard";
  allowed: false;
  code: "expensive-model" | "budget-exhausted";
  title: string;
  message: string;
  percent: number;
  outputPricePerM: number | null;
  run: Run | null;
  modelName: string | null;
}

export interface RestorePrudentResponse {
  ok: true;
  permission: Record<string, unknown>;
  /** opencode redémarré pour appliquer les règles (false : elles l'étaient déjà). */
  restarted: boolean;
}
