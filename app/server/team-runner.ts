// Propriétaire : L37b.
// TeamRunner (spécification §3.13 ; plan d'exécution it4, fiche L37b) : lancement, sessions d'étape sous plancher ETAPE vérifié,
// ordonnanceur, injections, dérivations d'étapes, reprise au démarrage (recover), groupe « team-runs » (routes-team-runs.ts).
//
// Honnêteté tenue ici (spéc. §6) :
// - l.1032 : une étape ne modifie rien, ne lance aucune commande, ne va pas sur Internet et ne délègue pas — le plancher ETAPE est
//   posé à la création de la session et son ÉCHO est vérifié (floorHolds + parentID) ; un écart supprime la session et échoue
//   l'étape, avant tout envoi facturé ;
// - l.1035 : le résultat est recopié dans la conversation par un message `noReply` (aucun appel d'IA, aucune ligne `usage`) ;
// - l.1037 : rien n'est envoyé ni facturé avant le CONTRÔLE DE FRAÎCHEUR (A4, D-eq-17) : `preflight.check` n'émet aucune requête
//   et le runner n'en émet aucune pour un refus ; `preflight.recheck` est refait APRÈS l'acceptation, avant toute injection et
//   avant toute session d'étape ;
// - D-eq-05 : après un arrêt (ou une interruption par rechargement), PLUS AUCUNE étape n'est lancée. `runStepInner` relit donc
//   l'arrêt à CHACUNE de ses attentes — revérification, création de la session, lecture des résultats précédents — et sa
//   transition vers « en-cours » est bloquante : la fenêtre qui va de la place réservée à `prompt_async` est fermée par
//   construction, et une session créée puis abandonnée est supprimée (dropStepSession) ;
// - U2, D-eq-26 : `message_text` (consigne réelle d'une étape) n'est JAMAIS journalisé ; un journal ne cite que `message_sha256`.
//   La demande, les pièces jointes et les précisions ne sortent d'ici que dans le message d'une étape ou dans l'injection
//   (D-eq-27 : aucune colonne ne les garde ; après un redémarrage elles sont relues localement par `requestFromStepMessage`).
//
// Report de MX-EQ au train de V0 (mesures ME-1 à ME-8), appliqué :
// - `request_message_id` et `result_message_id` = `info.id` de la RÉPONSE de `POST /session/:racine/message` (ME-3) ;
// - fin d'étape lue APRÈS la clôture du dernier message d'assistant, pas au premier `session.idle` (ME-2 : après un `doom_loop`
//   refusé, deux repos à ≈ 273 ms d'écart) ;
// - « tronquée » comptée sur une liste qui contient TOUS les messages d'assistant (`limit ≥ steps + 1`, ME-7) ; coût = somme de
//   `usage.cost` de la session, jamais la somme des seuls messages rendus par `limit` ;
// - abandon (`arretee` / `interrompue`) lu AVANT le test « texte vide » : un message arrêté porte à la fois du texte et
//   `MessageAbortedError` (ME-6) ;
// - revérification « règles effectives = instantané » sur une FORME CANONIQUE (canonicalAgentRules, ME-5 : l'ordre des `allow`
//   des dossiers de fiches change d'un chargement à l'autre, à configuration égale).
//
// Le squelette de T4 inscrivait déjà le prédicat de la garde de rechargement (D-eq-06) : cette inscription est GARDÉE, avec la
// dérivation, l'abonnement « opencode.connection », le démarrage (recover) et les routes du groupe « team-runs » prévus par
// EQ_STEP_ORDER. neutralRunner reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan it4 §2.3).
import { createHash, randomUUID } from "node:crypto";
import { billRefusal } from "./config-queue.ts";
import {
  type EqContext,
  type EqModule,
  EqPortUnavailableError,
  type PlannedStep,
  type RecheckOutcome,
  type RunPlan,
  type RunnerRefusal,
  type StepRow,
  type TeamRow,
  type TeamRunnerPort,
} from "./contracts-eq.ts";
import { errorMessage } from "./log.ts";
import type { OcGlobalEvent, OcSession } from "./opencode.ts";
import { resolvePrice } from "./pricing.ts";
import { redactSecrets } from "./redact.ts";
import { registerTeamRunRoutes } from "./routes-team-runs.ts";
import { floorHash } from "./session-floor-service.ts";
import { modelName, type Rule, truncateGlob } from "./shared/assistant-rules.ts";
import type { StopCause, StopResult } from "./shared/cockpit-event-types.ts";
import { type FlowEstimateContext, suiteEstimate } from "./shared/flow-estimate.ts";
import {
  deliverable,
  type FlowState,
  injectionText,
  type InjectionKind,
  nextActions,
  partialDeliverable,
  requestFromStepMessage,
  type StepResult,
  stepMessage,
} from "./shared/flow.ts";
import { ID_RE } from "./shared/ids.ts";
import { buildFloor, canonicalRules, floorHolds, floorMark } from "./shared/session-floors.ts";
import { FLOW_LIMITS, planSteps } from "./shared/team-limits.ts";
import { pauseChangement, remplir, TEXTES } from "./shared/team-texts.ts";
import type {
  Flow,
  StepAssistant,
  TeamContinueBody,
  TeamErrorCode,
  TeamPauseView,
  TeamRunBody,
  TeamRunCause,
  TeamRunStarted,
  TeamRunState,
  TeamRunView,
  TeamStepState,
} from "./shared/team-types.ts";
import { emitEquipe } from "./team-events.ts";
import { createTeamStore, type StepKey, type TeamStore } from "./team-store.ts";

// --- Constantes ---------------------------------------------------------------------------------------------------------------

/** Délai de chaque requête d'étape à opencode (création, envoi, lecture, suppression), comme le plancher de session. */
export const STEP_TIMEOUT_MS = 15_000;
/** Sondage de GET /session/status quand la session d'étape a disparu des occupées (fiche L37b, étape 4). */
export const STEP_STATUS_POLL_MS = 15_000;
/** Nouvel essai après un refus de facturation (billRefusal) : étape « en-file » puis reprise. */
export const BILL_RETRY_MS = 5_000;
/** Essais bornés : au-delà, l'étape échoue (le cockpit ne boucle jamais sans fin). */
export const BILL_RETRY_MAX = 12;
/** `?limit=` de la lecture de fin d'étape ; relevé à `steps + 1` pour compter TOUS les messages d'assistant (ME-7). */
export const STEP_MESSAGE_LIMIT = 20;
/** Attente de la ligne `usage` du dernier message d'assistant avant de relever le coût (le processeur l'écrit en file). */
export const USAGE_WAIT_MS = 2_000;
const USAGE_POLL_MS = 5;
/** Premiers caractères de la demande repris dans le titre de la conversation créée (masqués). */
export const RUN_TITLE_DEMANDE_MAX = 40;
/** Cause enregistrée sur une étape ou un lancement : courte, d'une seule ligne, masquée. */
const CAUSE_MAX = 160;
/** Titre de repli quand l'équipe du plan n'est plus installée (son déroulé reste celui du lancement). */
const TEAM_TITLE_FALLBACK = "Équipe";

const P = TEXTES.partout;

/** Lancements dont le prédicat de rechargement répond « occupé » (D-eq-06) ; les pauses « attente-* » en sont absentes. */
const BUSY_RUN_STATES: ReadonlySet<TeamRunState> = new Set<TeamRunState>(["preparation", "en-cours"]);

// Les états d'étape qui occupent (« en-file », « en-cours », « attente-accord », D-eq-06) n'ont pas de liste à part : une étape
// est dans `run.inflight` de sa place réservée à l'enregistrement de sa fin, et un nouvel essai différé laisse son lancement
// « en-cours ». `stepsBusy()` lit ces deux signaux.

/** États d'un lancement que la reprise au démarrage examine (les autres sont finis). */
const RECOVERABLE_STATES: readonly TeamRunState[] = ["preparation", "en-cours", "attente-verification", "attente-budget", "attente-modification"];

/** États d'un lancement qui admettent [Ajouter les résultats obtenus à la conversation] (D-eq-22). */
const ADD_RESULTS_STATES: ReadonlySet<TeamRunState> = new Set<TeamRunState>(["terminee", "arretee", "echec", "interrompue", "plafond"]);

// --- Outils -------------------------------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const enc = (value: string): string => encodeURIComponent(value);
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Cause lisible enregistrée en base : masquée, sur une seule ligne, bornée (jamais un texte de message). */
const cleanCause = (raw: string): string => redactSecrets(raw).replace(/[\r\n]+/g, " ").trim().slice(0, CAUSE_MAX);

/** Référence d'IA « fournisseur/modèle » ; null quand la forme n'est pas lisible. */
function modelRef(model: string | null): { providerID: string; modelID: string } | null {
  if (typeof model !== "string") return null;
  const slash = model.indexOf("/");
  return slash > 0 && slash < model.length - 1 ? { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } : null;
}

/**
 * Forme canonique des règles effectives d'un assistant (ME-5) : chaque suite de règles CONSÉCUTIVES de même permission et de
 * même action est triée par motif. L'ordre des `allow` que le chargeur d'opencode produit pour les dossiers de fiches change d'un
 * chargement à l'autre, à configuration égale ; comparées telles quelles, les empreintes donneraient de fausses pauses
 * « attente-modification » ou « À vérifier » après chaque rechargement. Trier un groupe de même action ne change aucune décision :
 * la dernière règle qui correspond l'emporte, et elles portent toutes la même action.
 * L37p bâtit `rulesSha256` sur cette même forme (plan it4, report MX-EQ §2).
 */
export function canonicalAgentRules(rules: readonly Rule[]): string {
  const out: Rule[] = [];
  let i = 0;
  while (i < rules.length) {
    const head = rules[i] as Rule;
    let j = i + 1;
    while (j < rules.length && rules[j]?.permission === head.permission && rules[j]?.action === head.action) j++;
    out.push(...rules.slice(i, j).toSorted((a, b) => (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0)));
    i = j;
  }
  return canonicalRules(out);
}

/** Texte des parties « text » d'un message opencode, dans l'ordre. */
function textOf(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

// --- Mémoire d'un lancement ---------------------------------------------------------------------------------------------------

/**
 * Ce que le runner garde d'un lancement, en mémoire seulement (D-eq-27) : la demande et les pièces jointes n'ont aucune colonne
 * et ne sont jamais journalisées. Après un redémarrage, elles sont relues localement par `requestFromStepMessage`.
 */
interface RunMemory {
  runId: string;
  rootId: string;
  directory: string;
  titre: string;
  flow: Flow;
  /** Instantané du lancement (règles, plancher, IA de chaque étape) ; null après un redémarrage, jusqu'à une relance. */
  plan: RunPlan | null;
  demande: string | null;
  fichiers: string[];
  precisions: string[];
  /** Texte complet du résultat de chaque étape terminée (relais, livrable) ; relu dans la session si la mémoire a été perdue. */
  resultats: Map<string, string>;
  corriges: Set<string>;
  pausesFranchies: string[];
  tour: number;
  tentatives: Map<string, number>;
  state: TeamRunState;
  /** Raison de la pause « À vérifier » du contrôle de fraîcheur (A4), ou assistant changé d'une pause de modification. */
  changement: { code: TeamErrorCode; details?: Record<string, unknown> } | null;
  /** Bloc « pause » du déroulé qui a mis l'équipe en attente. */
  pauseBloc: string | null;
  /** La pause vient du contrôle de fraîcheur : [Continuer] le refait avant toute injection et toute étape. */
  attenteFraicheur: boolean;
  /** Arrêt demandé (décorateur de stopTree) : plus aucune étape n'est lancée. */
  stopping: boolean;
  /** Étapes qui occupent une place, y compris entre POST /session et prompt_async (D-eq-06). */
  inflight: Set<string>;
  billRetries: Map<string, number>;
  timers: Set<NodeJS.Timeout>;
  chain: Promise<void>;
}

/** Surveillance d'une session d'étape : ce que la dérivation observe entre l'envoi et la fin. */
interface StepWatch {
  run: RunMemory;
  key: StepKey;
  sessionId: string;
  lastAssistant: string | null;
  openAssistant: boolean;
  idleSeen: boolean;
  sawWork: boolean;
  sessionError: string | null;
  settled: boolean;
  settle: () => void;
  done: Promise<void>;
}

export interface TeamRunnerOptions {
  /** Horloge (tests). */
  now?: () => number;
  /** Sondage de GET /session/status (TESTS SEULEMENT : jamais lu d'une variable d'environnement). */
  pollMs?: number;
  /** Nouvel essai après un refus de facturation (TESTS SEULEMENT). */
  retryMs?: number;
  /** Attente de la ligne `usage` du dernier message (TESTS SEULEMENT). */
  usageWaitMs?: number;
}

/** Port du runner, plus ce que le module branche lui-même (dérivation, démarrage, reconnexion, arrêt du module). */
export interface TeamRunner extends TeamRunnerPort {
  onEvent(event: OcGlobalEvent): void;
  /** Démarrage : rattache les lancements en cours, n'en lance aucun (fiche L37b). */
  recover(): Promise<void>;
  /** Reconnexion au flux d'opencode : même vérification que `recover`, sans mettre en pause. */
  onConnection(data: { connected: boolean }): void;
  /** Minuteurs retirés et surveillances relâchées (fermeture du cockpit, tests). */
  dispose(): void;
}

// --- Runner -------------------------------------------------------------------------------------------------------------------

export function createTeamRunner(eq: EqContext, options: TeamRunnerOptions = {}): TeamRunner {
  const { c11 } = eq;
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? STEP_STATUS_POLL_MS;
  const retryMs = options.retryMs ?? BILL_RETRY_MS;
  const usageWaitMs = options.usageWaitMs ?? USAGE_WAIT_MS;
  const store: TeamStore = createTeamStore({ db: c11.db, now });
  const runs = new Map<string, RunMemory>();
  const watches = new Map<string, StepWatch>();
  let poll: NodeJS.Timeout | null = null;
  let closed = false;

  /** Journal du runner : jamais de consigne, de demande, de précision ni de texte d'instantané (U2, D-eq-26). */
  const warn = (message: string, data: Record<string, unknown> = {}): void => c11.log.warn(`équipes : ${message}`, data);

  // --- Lecture de la base -----------------------------------------------------------------------------------------------------

  const parseFlow = (raw: string): Flow => {
    try {
      const value = JSON.parse(raw) as Flow;
      return Array.isArray(value?.blocs) ? value : { version: 1, blocs: [] };
    } catch {
      return { version: 1, blocs: [] };
    }
  };

  const parseList = (raw: string): string[] => {
    try {
      const value = JSON.parse(raw) as unknown;
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  };

  const parseConfirmations = (runId: string): Record<string, boolean> => {
    const raw = store.runs.get(runId)?.confirmations ?? "{}";
    try {
      const value = JSON.parse(raw) as unknown;
      if (!isRecord(value)) return {};
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item === true]));
    } catch {
      return {};
    }
  };

  /** Dernière tentative de chaque étape du tour courant (ligne qui fait foi). */
  const lastRows = (runId: string, tour: number): Map<string, StepRow> => {
    const out = new Map<string, StepRow>();
    for (const row of store.steps.ofRun(runId)) {
      if (row.tour !== tour) continue;
      const kept = out.get(row.step_id);
      if (!kept || row.tentative >= kept.tentative) out.set(row.step_id, row);
    }
    return out;
  };

  const flowState = (run: RunMemory): FlowState => {
    const rows = lastRows(run.runId, run.tour);
    const etapes: Record<string, TeamStepState> = {};
    for (const planned of planSteps(run.flow)) {
      etapes[planned.stepId] = run.inflight.has(planned.stepId) ? "en-cours" : (rows.get(planned.stepId)?.state ?? "prevue");
    }
    const resultats: Record<string, string> = {};
    for (const [stepId, texte] of run.resultats) resultats[stepId] = texte;
    return { etapes, pausesFranchies: run.pausesFranchies, resultats };
  };

  const keyOf = (run: RunMemory, stepId: string): StepKey => ({
    runId: run.runId,
    stepId,
    tour: run.tour,
    tentative: run.tentatives.get(stepId) ?? 1,
  });

  const plannedOf = (run: RunMemory, stepId: string): PlannedStep | null => run.plan?.etapes.find((step) => step.stepId === stepId) ?? null;

  const concurrentSteps = (): number => {
    const value = c11.settings.get().teams.concurrentSteps;
    return Math.max(1, Math.min(Math.trunc(value) || 1, FLOW_LIMITS.simultanees));
  };

  /**
   * Équipe d'un plan : `RunPlan` porte le déroulé et son empreinte, jamais le nom de l'équipe (contrats de T4). L'équipe est donc
   * retrouvée dans le magasin par son déroulé ; à défaut (équipe supprimée depuis l'estimation), le lancement garde son déroulé et
   * un titre de repli.
   */
  const teamOfPlan = (plan: RunPlan): TeamRow | null => {
    const wanted = JSON.stringify(plan.flow);
    return store.teams.list().find((row) => JSON.stringify(parseFlow(row.flow)) === wanted) ?? null;
  };

  // --- États et événements ----------------------------------------------------------------------------------------------------

  const emitRun = (run: RunMemory): void => {
    const row = store.runs.get(run.runId);
    if (!row) return;
    run.state = row.state;
    emitEquipe(c11.hub, "equipe.lancement", { runId: run.runId, rootId: run.rootId, state: row.state, cause: row.cause });
  };

  const setRunState = (run: RunMemory, to: TeamRunState, cause: TeamRunCause | null = null): boolean => {
    const changed = store.runs.setState(run.runId, to, { cause });
    if (changed) emitRun(run);
    return changed;
  };

  const emitStep = (run: RunMemory, key: StepKey, state: TeamStepState, sessionId: string | null): void => {
    emitEquipe(c11.hub, "equipe.etape", {
      runId: run.runId,
      rootId: run.rootId,
      stepId: key.stepId,
      tour: key.tour,
      tentative: key.tentative,
      state,
      sessionId,
    });
  };

  /** Événement d'audit : identifiants, codes et empreintes seulement (le magasin refuse tout texte de message). */
  const audit = (
    runId: string,
    kind: string,
    data: Record<string, string | number | boolean | null> = {},
    par: "vous" | "cockpit" = "cockpit",
  ): void => {
    try {
      store.events.append({ runId, kind, par, data });
    } catch (err) {
      warn("événement d'audit refusé", { runId, kind, error: errorMessage(err) });
    }
  };

  // --- Pause, vue et estimation du reste --------------------------------------------------------------------------------------

  /** Résultat de la dernière étape terminée : ce que la carte de pause montre et ce qu'une correction remplace. */
  const dernierResultat = (run: RunMemory): TeamPauseView["resultat"] => {
    const rows = lastRows(run.runId, run.tour);
    let last: StepRow | null = null;
    for (const planned of planSteps(run.flow)) {
      const row = rows.get(planned.stepId);
      if (row?.state === "terminee") last = row;
    }
    if (!last) return null;
    return { etape: last.step_id, titre: last.titre, texte: run.resultats.get(last.step_id) ?? last.result_excerpt ?? "" };
  };

  /** Première étape non terminée du chemin (libellé d'une pause de budget). */
  const prochaineEtape = (run: RunMemory): { stepId: string; titre: string } | null => {
    const rows = lastRows(run.runId, run.tour);
    for (const planned of planSteps(run.flow)) {
      const row = rows.get(planned.stepId);
      if (row?.state === "terminee") continue;
      return { stepId: planned.stepId, titre: row?.titre ?? planned.stepId };
    }
    return null;
  };

  /** Message écrit dans le bloc « pause » du déroulé ; à défaut, le titre de la pause. */
  const pauseMessage = (run: RunMemory): string => {
    const bloc = run.flow.blocs.find((block) => block.type === "pause" && block.id === run.pauseBloc);
    return bloc && bloc.type === "pause" && bloc.message.trim().length > 0 ? bloc.message : P.pauses.verification.titre;
  };

  /**
   * Contexte d'estimation du chemin restant, SANS aucune lecture d'opencode : IA et variante relues dans les lignes d'étapes (ou
   * dans l'instantané du lancement), tarifs du catalogue déjà chargé, moyennes observées de la base.
   */
  const estimateContext = (run: RunMemory): FlowEstimateContext => {
    const rows = lastRows(run.runId, run.tour);
    const lite = c11.catalog.lite();
    const assistants = new Map<string, StepAssistant>();
    for (const planned of planSteps(run.flow)) {
      const nom = rows.get(planned.stepId)?.agent ?? plannedOf(run, planned.stepId)?.assistant;
      if (!nom) continue;
      assistants.set(nom, {
        name: nom,
        title: nom,
        origin: "catalogue",
        rights: "lecture",
        mode: "all",
        hidden: false,
        rules: [],
        model: null,
        available: true,
        steps: null,
        taille: null,
      });
    }
    const since = now() - 30 * 24 * 60 * 60 * 1000;
    return {
      assistants,
      iaDe: (step) => {
        const row = rows.get(step.id);
        const planned = plannedOf(run, step.id);
        const model = row?.model ?? planned?.model ?? null;
        if (model === null) return null;
        return { model, variant: row?.variant ?? planned?.variant ?? null, niveau: step.niveau, label: modelName(model, lite) };
      },
      prix: (model) => {
        const ref = modelRef(model);
        return ref === null ? null : (resolvePrice(ref.providerID, ref.modelID, c11.ledger.pricingContext())?.price ?? null);
      },
      observe: (assistant, model) => store.observedStepCost(assistant, model, since),
      simultanees: concurrentSteps(),
    };
  };

  /**
   * Passages déjà TERMINÉS de chaque étape : depuis L42a une relecture repasse par la même étape à chaque tour, et un seul état
   * ne dit pas combien de fois elle est passée. Une ligne par (étape, tour), sa dernière tentative faisant foi.
   */
  const toursTermines = (runId: string): Map<string, number> => {
    const derniere = new Map<string, StepRow>();
    for (const row of store.steps.ofRun(runId)) {
      const cle = `${row.step_id}\u0000${row.tour}`;
      const kept = derniere.get(cle);
      if (!kept || row.tentative >= kept.tentative) derniere.set(cle, row);
    }
    const out = new Map<string, number>();
    for (const row of derniere.values()) if (row.state === "terminee") out.set(row.step_id, (out.get(row.step_id) ?? 0) + 1);
    return out;
  };

  const suiteOf = (run: RunMemory): { typique: number; maximum: number } => {
    const rows = lastRows(run.runId, run.tour);
    const finis = toursTermines(run.runId);
    // UNE entrée par étape, jamais une par passage : `suiteEstimate` additionne les comptes de tours qu'on lui donne.
    const vues = new Set<string>();
    const etapes: Array<{ stepId: string; state: TeamStepState; tours: number }> = [];
    for (const planned of planSteps(run.flow)) {
      if (vues.has(planned.stepId)) continue;
      vues.add(planned.stepId);
      etapes.push({
        stepId: planned.stepId,
        state: rows.get(planned.stepId)?.state ?? ("prevue" as TeamStepState),
        tours: finis.get(planned.stepId) ?? 0,
      });
    }
    const estimate = suiteEstimate(run.flow, { etapes }, estimateContext(run));
    return { typique: estimate.typique, maximum: estimate.maximum };
  };

  const pauseView = (run: RunMemory, state: TeamRunState, cause: string | null): TeamPauseView | null => {
    const base = {
      blocId: run.pauseBloc,
      resultat: null as TeamPauseView["resultat"],
      suite: suiteOf(run),
      changement: null as TeamPauseView["changement"],
    };
    if (state === "attente-budget") {
      return { ...base, kind: "budget", message: remplir(P.pauses.budget.message, { titre: prochaineEtape(run)?.titre ?? "" }) };
    }
    if (state === "attente-modification") {
      const nom = run.changement?.details?.nom;
      const message = typeof nom === "string" ? remplir(P.pauses.modification.messageNom, { nom }) : P.pauses.modification.message;
      return { ...base, kind: "modification", message };
    }
    if (state !== "attente-verification") return null;
    if (cause === "changement") {
      return { ...base, blocId: null, kind: "changement", message: pauseChangement(run.changement?.code ?? "autre"), changement: run.changement };
    }
    if (cause === "redemarrage-cockpit") return { ...base, kind: "redemarrage-cockpit", message: P.pauses["redemarrage-cockpit"].message };
    return { ...base, kind: "verification", message: pauseMessage(run), resultat: dernierResultat(run) };
  };

  /** Demande et pièces jointes relues dans le `message_text` d'une étape qui a reçu la demande (aucune requête, D-eq-27). */
  const readRequest = (runId: string): { demande: string; fichiers: string[] } | null => {
    for (const row of store.steps.ofRun(runId)) {
      if (row.message_text === null) continue;
      const found = requestFromStepMessage(row.message_text, runId);
      if (found) return found;
    }
    return null;
  };

  /** Mémoire minimale reconstruite depuis la base (vue d'un lancement qu'aucune exécution de ce processus n'a suivi). */
  const memoryFromRow = (runId: string): RunMemory | null => {
    const row = store.runs.get(runId);
    if (!row) return null;
    return {
      runId,
      rootId: row.root_session_id,
      directory: row.directory,
      titre: row.team_titre,
      flow: parseFlow(row.flow),
      plan: null,
      demande: null,
      fichiers: [],
      precisions: parseList(row.precisions),
      resultats: new Map(),
      corriges: new Set(),
      pausesFranchies: [],
      tour: 1,
      tentatives: new Map(),
      state: row.state,
      changement: null,
      pauseBloc: null,
      attenteFraicheur: false,
      stopping: false,
      inflight: new Set(),
      billRetries: new Map(),
      timers: new Set(),
      chain: Promise.resolve(),
    };
  };

  const view = (runId: string): TeamRunView | null => {
    const row = store.runs.get(runId);
    const base = row ? store.runs.view(runId) : null;
    if (!row || !base) return null;
    // Lancement non suivi par ce processus : mémoire de lecture seulement, jamais ajoutée au registre (stepsBusy reste vrai).
    const run = runs.get(runId) ?? memoryFromRow(runId);
    if (!run) return base;
    const lite = c11.catalog.lite();
    return {
      ...base,
      steps: base.steps.map((step) => ({ ...step, ia: { ...step.ia, label: step.ia.model === null ? null : modelName(step.ia.model, lite) } })),
      pause: pauseView(run, row.state, row.cause),
      suite: row.state === "terminee" || row.state === "arretee" ? null : suiteOf(run),
      // D-eq-27 : un lancement dont la demande n'est plus reconstituable (textes purgés, aucune étape envoyée) n'est pas
      // relançable. Seule la BASE fait foi, comme pour la route de relance : la mémoire du processus n'est qu'un cache de
      // lecture, que la purge de la conversation ne touche pas — l'écran dirait sinon « relançable » jusqu'au redémarrage.
      relancable: base.relancable && readRequest(runId) !== null,
    };
  };

  // --- Surveillance des sessions d'étape --------------------------------------------------------------------------------------

  const armPoll = (): void => {
    if (poll !== null || closed || watches.size === 0) return;
    poll = setInterval(() => void probeSessions(), pollMs);
    poll.unref?.();
  };

  const disarmPoll = (): void => {
    if (poll !== null && watches.size === 0) {
      clearInterval(poll);
      poll = null;
    }
  };

  /** Sondage de GET /session/status : une session d'étape qui a disparu des occupées a fini (fiche L37b, étape 4). */
  const probeSessions = async (): Promise<void> => {
    const directories = new Set([...watches.values()].map((watch) => watch.run.directory));
    for (const directory of directories) {
      let statuses: unknown;
      try {
        statuses = await c11.client.request<unknown>("GET", "/session/status", { directory, timeoutMs: STEP_TIMEOUT_MS });
      } catch (err) {
        warn("état des sessions d'étape illisible : nouvel essai au prochain sondage", { error: errorMessage(err) });
        continue;
      }
      const busy = isRecord(statuses) ? statuses : {};
      for (const watch of [...watches.values()]) {
        if (watch.run.directory !== directory || watch.settled) continue;
        // Jamais avant d'avoir vu la session travailler : entre prompt_async et le premier événement, elle n'est pas encore occupée.
        if (!watch.sawWork || watch.openAssistant) continue;
        if (!Object.hasOwn(busy, watch.sessionId)) watch.settle();
      }
    }
  };

  const watchStep = (run: RunMemory, key: StepKey, sessionId: string): StepWatch => {
    let resolve = (): void => undefined;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const watch: StepWatch = {
      run,
      key,
      sessionId,
      lastAssistant: null,
      openAssistant: false,
      idleSeen: false,
      sawWork: false,
      sessionError: null,
      settled: false,
      settle: () => {
        if (watch.settled) return;
        watch.settled = true;
        if (watches.get(sessionId) === watch) watches.delete(sessionId);
        disarmPoll();
        resolve();
      },
      done,
    };
    watches.set(sessionId, watch);
    armPoll();
    return watch;
  };

  const onEvent = (global: OcGlobalEvent): void => {
    const event = isRecord(global) ? global.payload : null;
    if (!isRecord(event) || typeof event.type !== "string") return;
    const p = isRecord(event.properties) ? event.properties : null;
    if (!p) return;
    switch (event.type) {
      case "message.updated": {
        const info = p.info;
        if (!isRecord(info) || typeof info.sessionID !== "string" || info.role !== "assistant") return;
        const watch = watches.get(info.sessionID);
        if (!watch) return;
        watch.sawWork = true;
        if (typeof info.id === "string") watch.lastAssistant = info.id;
        const time = isRecord(info.time) ? info.time : {};
        const closedMessage = typeof time.completed === "number" || (info.error !== undefined && info.error !== null);
        watch.openAssistant = !closedMessage;
        // ME-2 : après un doom_loop refusé, le dernier message d'assistant est clos APRÈS le premier repos.
        if (closedMessage && watch.idleSeen) watch.settle();
        return;
      }
      case "session.status": {
        const watch = typeof p.sessionID === "string" ? watches.get(p.sessionID) : undefined;
        if (!watch) return;
        const status = isRecord(p.status) ? p.status : null;
        if (status && status.type !== "idle") watch.sawWork = true;
        return;
      }
      case "session.idle": {
        const watch = typeof p.sessionID === "string" ? watches.get(p.sessionID) : undefined;
        if (!watch) return;
        watch.idleSeen = true;
        watch.sawWork = true;
        if (!watch.openAssistant) watch.settle();
        return;
      }
      case "session.error": {
        const watch = typeof p.sessionID === "string" ? watches.get(p.sessionID) : undefined;
        if (!watch) return;
        const error = isRecord(p.error) ? p.error : null;
        const data = error && isRecord(error.data) ? error.data : null;
        watch.sessionError = typeof data?.message === "string" ? data.message : typeof error?.name === "string" ? error.name : "erreur";
        watch.sawWork = true;
        return;
      }
      case "permission.asked": {
        const info = isRecord(p.info) ? p.info : p;
        const watch = typeof info.sessionID === "string" ? watches.get(info.sessionID) : undefined;
        if (!watch) return;
        // Sous ETAPE, seul `doom_loop` peut demander (ME-2) : l'utilisateur répond par la carte d'autorisation existante.
        if (store.steps.setState(watch.key, "attente-accord")) emitStep(watch.run, watch.key, "attente-accord", watch.sessionId);
        return;
      }
      case "permission.replied": {
        const watch = typeof p.sessionID === "string" ? watches.get(p.sessionID) : undefined;
        if (!watch) return;
        if (store.steps.setState(watch.key, "en-cours")) emitStep(watch.run, watch.key, "en-cours", watch.sessionId);
        return;
      }
      default:
        return;
    }
  };

  // --- Injection dans la conversation (D-eq-14) -------------------------------------------------------------------------------

  /**
   * Message `noReply` injecté dans la racine : aucun appel d'IA, donc aucune ligne `usage` (spéc. §6 l.1035). L'identifiant
   * enregistré est `info.id` de la RÉPONSE (ME-3), jamais le marqueur seul. Mode « carte-seule » (D-eq-14) : aucune injection,
   * la carte porte [Ajouter à la conversation].
   */
  const inject = async (run: RunMemory, kind: InjectionKind, texte: string): Promise<string | null> => {
    if (eq.injection === "carte-seule") return null;
    const plan = run.plan;
    const ia = plan?.iaConversation ?? null;
    const ref = ia === null ? null : modelRef(ia.model);
    const body: Record<string, unknown> = {
      noReply: true,
      ...(plan?.agentConversation ? { agent: plan.agentConversation } : {}),
      ...(ref ? { model: ref } : {}),
      ...(ia?.variant ? { variant: ia.variant } : {}),
      parts: [{ type: "text", text: injectionText(kind, { runId: run.runId, equipe: run.titre, texte }) }],
    };
    const response = await c11.client.request<unknown>("POST", `/session/${enc(run.rootId)}/message`, {
      directory: run.directory,
      body,
      timeoutMs: STEP_TIMEOUT_MS,
    });
    const info = isRecord(response) ? response.info : null;
    if (!isRecord(info) || typeof info.id !== "string" || !ID_RE.test(info.id)) throw new Error("message injecté sans identifiant lisible");
    c11.ledger.markPromptKind(info.id, kind === "demande" ? "equipe-demande" : "equipe-resultat");
    return info.id;
  };

  // --- Lancement --------------------------------------------------------------------------------------------------------------

  /** File d'un lancement : deux changements d'état du même lancement ne se croisent jamais. */
  const schedule = (run: RunMemory, task: () => Promise<void>): Promise<void> => {
    run.chain = run.chain.then(task, task).catch((err: unknown) => {
      warn("tâche d'équipe en échec", { runId: run.runId, error: errorMessage(err) });
    });
    return run.chain;
  };

  const launch = async (plan: RunPlan, body: TeamRunBody): Promise<TeamRunStarted> => {
    const team = teamOfPlan(plan);
    const titre = team?.titre ?? TEAM_TITLE_FALLBACK;
    // (1) Racine existante, ou créée sous plancher CONVERSATION vérifié (D-eq-23) ; premier envoi possible seulement après (3).
    let rootId = plan.rootId;
    if (rootId === null) {
      const session = await c11.ports.floors.createWithFloor("CONVERSATION", {
        directory: plan.directory,
        title: `${titre} : ${redactSecrets(body.demande).slice(0, RUN_TITLE_DEMANDE_MAX)}`,
      });
      rootId = (session as OcSession).id;
    }
    // (2) Lancement en « preparation » : instantané, empreintes, mode et confirmations ; étapes « prevue ».
    const runId = randomUUID();
    store.runs.create({
      id: runId,
      teamId: team?.id ?? null,
      teamTitre: titre,
      flow: plan.flow,
      flowSha256: plan.flowSha256,
      estimateSha256: plan.estimateSha256,
      modeUi: plan.modeUi,
      rootId,
      directory: plan.directory,
      estimate: { typique: plan.estimate.typique, maximum: plan.estimate.maximum },
      plafond: plan.plafond,
      confirmations: Object.fromEntries(Object.entries(body.confirmations ?? {}).map(([key, value]) => [key, value === true])),
    });
    for (const planned of planSteps(plan.flow)) {
      const step = plan.etapes.find((entry) => entry.stepId === planned.stepId);
      store.steps.create({
        runId,
        stepId: planned.stepId,
        tour: planned.tour,
        tentative: 1,
        ordre: planned.ordre,
        blocIndex: planned.blocIndex,
        titre: step?.titre ?? planned.stepId,
        agent: step?.assistant ?? "",
        state: "prevue",
      });
    }
    const run: RunMemory = {
      runId,
      rootId,
      directory: plan.directory,
      titre,
      flow: plan.flow,
      plan,
      // D-eq-27 : demande et pièces jointes gardées EN MÉMOIRE, jamais en base ni dans un journal.
      demande: body.demande,
      fichiers: [...body.fichiers],
      precisions: [],
      resultats: new Map(),
      corriges: new Set(),
      pausesFranchies: [],
      tour: 1,
      tentatives: new Map(),
      state: "preparation",
      changement: null,
      pauseBloc: null,
      attenteFraicheur: false,
      stopping: false,
      inflight: new Set(),
      billRetries: new Map(),
      timers: new Set(),
      chain: Promise.resolve(),
    };
    runs.set(runId, run);
    audit(runId, "lancement", { rootId, etapes: plan.etapes.length, plafond: plan.plafond, estimation: plan.estimateSha256 }, "vous");
    // (3) à (5) hors de la réponse : le navigateur reçoit 202 tout de suite.
    void schedule(run, () => startRun(run, { injecter: true }));
    return { runId, rootId };
  };

  const recheckPlan = async (run: RunMemory): Promise<RecheckOutcome> => {
    const plan = run.plan;
    if (!plan) return { ok: true };
    return eq.ports.preflight.recheck(plan, run.rootId);
  };

  /**
   * Préparation d'un lancement : contrôle de fraîcheur (A4, D-eq-17), puis injection de la demande. RIEN n'est envoyé ni facturé
   * avant ce contrôle : une modification met l'équipe en « attente-modification », un autre écart en pause « À vérifier ».
   * Rend vrai quand la boucle de l'ordonnanceur peut partir. Séparée de `tick` pour que [Continuer] n'attende QUE cette partie
   * (la réponse de POST …/continue ne doit pas rester ouverte jusqu'à la fin de toute l'équipe).
   */
  const prepareRun = async (run: RunMemory, options: { injecter: boolean }): Promise<boolean> => {
    if (closed || run.stopping) return false;
    let outcome: RecheckOutcome;
    try {
      outcome = await recheckPlan(run);
    } catch (err) {
      warn("contrôle de fraîcheur impossible : équipe en pause", { runId: run.runId, error: errorMessage(err) });
      outcome = { ok: false, genre: "changement", code: "opencode-injoignable" };
    }
    // Arrêt ou interruption pendant le contrôle : plus rien n'est injecté dans la conversation ni lancé (D-eq-05, spéc. §6).
    // L'état final a déjà été enregistré par `stopped` ou `interrupt` : aucune pause ne doit l'écraser.
    if (closed || run.stopping) return false;
    if (!outcome.ok) {
      run.attenteFraicheur = true;
      if (outcome.genre === "modification") {
        run.changement = null;
        setRunState(run, "attente-modification", "modification");
        audit(run.runId, "fraicheur", { genre: "modification" });
      } else {
        run.changement = { code: outcome.code, ...(outcome.details ? { details: outcome.details } : {}) };
        setRunState(run, "attente-verification", "changement");
        audit(run.runId, "fraicheur", { genre: "changement", code: outcome.code });
      }
      return false;
    }
    run.attenteFraicheur = false;
    run.changement = null;
    if (options.injecter && store.runs.get(run.runId)?.request_message_id === null) {
      try {
        const messageId = await inject(run, "demande", run.demande ?? "");
        if (messageId !== null) {
          store.runs.patch(run.runId, { requestMessageId: messageId });
          audit(run.runId, "injection", { genre: "demande", messageId });
        }
      } catch (err) {
        // L'injection de la demande n'est jamais facturée : son refus ne coûte rien et n'arrête pas l'équipe (carte seule, D-eq-14).
        warn("demande non injectée dans la conversation : carte seule", { runId: run.runId, error: errorMessage(err) });
        audit(run.runId, "injection-refusee", { genre: "demande" });
      }
    }
    return setRunState(run, "en-cours");
  };

  /** Préparation puis boucle de l'ordonnanceur, en une tâche (lancement et relance : la réponse HTTP est déjà partie). */
  const startRun = async (run: RunMemory, options: { injecter: boolean }): Promise<void> => {
    if (await prepareRun(run, options)) await tick(run);
  };

  // --- Ordonnanceur -----------------------------------------------------------------------------------------------------------

  const tick = async (run: RunMemory): Promise<void> => {
    // Arrêt demandé (`stopRequested`, avant même l'arrêt interne de stopTree) : plus AUCUNE action, ni ici ni au tour suivant.
    if (closed || run.stopping) return;
    if (store.runs.get(run.runId)?.state !== "en-cours") return;
    const actions = nextActions(run.flow, flowState(run), { simultanees: concurrentSteps() });
    const lancer = actions.filter((action): action is { lancer: string } => "lancer" in action);
    if (lancer.length > 0) {
      // Place réservée AVANT toute attente : deux passages de l'ordonnanceur ne lancent jamais la même étape deux fois.
      for (const action of lancer) run.inflight.add(action.lancer);
      await Promise.all(lancer.map((action) => runStep(run, action.lancer)));
      await tick(run);
      return;
    }
    const first = actions[0];
    if (!first) return;
    if ("pause" in first) {
      run.pauseBloc = first.pause;
      run.attenteFraicheur = false;
      setRunState(run, "attente-verification", "pause");
      audit(run.runId, "pause", { bloc: first.pause });
      return;
    }
    if ("echec" in first) {
      // D-eq-20 : l'échec d'une étape arrête l'équipe dans les deux modes.
      setRunState(run, "echec", "echec");
      audit(run.runId, "echec", { etape: first.echec });
      return;
    }
    await deliver(run);
  };

  // --- Une étape (primitive unique) -------------------------------------------------------------------------------------------

  type StepVerdict =
    | { kind: "ok"; agentRules: Rule[] }
    | { kind: "modification"; nom: string }
    | { kind: "ia-indisponible" }
    | { kind: "budget" }
    | { kind: "differe"; raison: string }
    | { kind: "plafond"; depense: number; plafond: number };

  const failStep = (run: RunMemory, key: StepKey, cause: string, sessionId: string | null): void => {
    const propre = cleanCause(cause);
    store.steps.setState(key, "echec", { cause: propre });
    emitStep(run, key, "echec", sessionId);
    audit(run.runId, "etape-echec", { etape: key.stepId, tentative: key.tentative, cause: propre });
  };

  /**
   * Session d'étape créée puis ABANDONNÉE avant tout envoi (arrêt, interruption, plafond, étape déjà close) : elle est
   * supprimée comme le fait la branche « plancher d'étape non vérifié », et rien n'est envoyé ni facturé (D-eq-05, spéc. §6).
   */
  const dropStepSession = async (run: RunMemory, stepId: string, sessionId: string): Promise<void> => {
    audit(run.runId, "etape-abandonnee", { etape: stepId, sessionId });
    try {
      await c11.client.request("DELETE", `/session/${enc(sessionId)}`, { directory: run.directory, timeoutMs: STEP_TIMEOUT_MS });
    } catch (err) {
      warn("session d'étape abandonnée non supprimée", { runId: run.runId, etape: stepId, error: errorMessage(err) });
    }
  };

  const recheckStep = async (run: RunMemory, planned: PlannedStep): Promise<StepVerdict> => {
    // Règles effectives de l'assistant = instantané, sur la forme canonique (ME-5).
    let agentRules: Rule[];
    try {
      const snapshot = await c11.lookup.get(run.directory);
      const agent = snapshot.agents.find((entry) => entry.name === planned.assistant);
      if (!agent) return { kind: "modification", nom: planned.assistant };
      if (canonicalAgentRules(agent.permission) !== canonicalAgentRules(planned.agentRules)) return { kind: "modification", nom: planned.assistant };
      agentRules = agent.permission;
    } catch (err) {
      warn("règles de l'assistant illisibles avant une étape : équipe en pause", { runId: run.runId, error: errorMessage(err) });
      return { kind: "modification", nom: planned.assistant };
    }
    // IA disponible : aucun repli sur une autre IA (décision n° 3).
    const ref = modelRef(planned.model);
    if (ref === null) return { kind: "ia-indisponible" };
    if (c11.catalog.loaded && !c11.catalog.get(ref.providerID, ref.modelID)) return { kind: "ia-indisponible" };
    // Garde-fou budgétaire (P6) : confirmé au lancement ou pendant une pause de budget.
    if (!c11.ledger.guard(ref, parseConfirmations(run.runId).budget === true).allowed) return { kind: "budget" };
    // Demandes facturées refusées par le cockpit (application de configuration, redémarrage, adresse Copilot à revérifier).
    const refusal = billRefusal({ queue: c11.configQueue, control: c11.control, copilotConfig: c11.copilotConfig });
    if (refusal !== null) return { kind: "differe", raison: refusal };
    // Plafond d'arrêt : le maximum de l'étape doit tenir sous le plafond (P3).
    const plafond = store.runs.get(run.runId)?.plafond ?? null;
    if (plafond !== null) {
      const depense = store.spentOfRun(run.runId);
      // Coût INCONNU : aucune ligne dans l'estimation du lancement (étape hors du chemin estimé), ou une ligne sans montant
      // (prix illisible à l'estimation). Le contrôle ne peut alors rien garantir, donc il refuse. Un `?? 0` le neutraliserait :
      // toute étape sans montant passerait sous n'importe quel plafond, et l'arrêt au plafond ne tiendrait plus (P3).
      const maximum = run.plan?.estimate.parEtape.find((ligne) => ligne.stepId === planned.stepId)?.maximum ?? null;
      if (maximum === null || depense + maximum > plafond) return { kind: "plafond", depense, plafond };
    }
    return { kind: "ok", agentRules };
  };

  const retryLater = (run: RunMemory, stepId: string, key: StepKey): void => {
    const timer = setTimeout(() => {
      run.timers.delete(timer);
      if (closed || run.stopping) return;
      if (store.steps.get(key)?.state !== "en-file") return;
      void schedule(run, async () => {
        run.inflight.add(stepId);
        try {
          await runStepInner(run, stepId, key);
        } catch (err) {
          warn("nouvel essai d'étape en échec", { runId: run.runId, etape: stepId, error: errorMessage(err) });
          failStep(run, key, errorMessage(err), store.steps.get(key)?.session_id ?? null);
        } finally {
          run.inflight.delete(stepId);
        }
        await tick(run);
      });
    }, retryMs);
    timer.unref?.();
    run.timers.add(timer);
  };

  const runStep = async (run: RunMemory, stepId: string): Promise<void> => {
    const key = keyOf(run, stepId);
    try {
      await runStepInner(run, stepId, key);
    } catch (err) {
      warn("étape en échec", { runId: run.runId, etape: stepId, error: errorMessage(err) });
      failStep(run, key, errorMessage(err), store.steps.get(key)?.session_id ?? null);
    } finally {
      run.inflight.delete(stepId);
    }
  };

  const runStepInner = async (run: RunMemory, stepId: string, key: StepKey): Promise<void> => {
    const planned = plannedOf(run, stepId);
    const order = planSteps(run.flow).find((entry) => entry.stepId === stepId);
    if (!planned || !order) {
      failStep(run, key, "étape inconnue de l'instantané du lancement", null);
      return;
    }

    // (1) Revérifications, avant toute création de session et avant tout envoi.
    const verdict = await recheckStep(run, planned);
    // Arrêt ou interruption pendant la revérification (elle lit les règles de l'assistant, donc elle attend) : aucune session
    // n'est créée, aucune pause n'écrase l'état final déjà enregistré (D-eq-05, spéc. §6 : « plus aucune étape lancée »).
    if (closed || run.stopping) return;
    if (verdict.kind === "modification") {
      run.changement = { code: "assistant-absent", details: { nom: verdict.nom } };
      run.attenteFraicheur = false;
      setRunState(run, "attente-modification", "modification");
      audit(run.runId, "pause-modification", { etape: stepId, assistant: verdict.nom });
      return;
    }
    if (verdict.kind === "ia-indisponible") {
      failStep(run, key, "ia-indisponible", null);
      return;
    }
    if (verdict.kind === "budget") {
      run.attenteFraicheur = false;
      setRunState(run, "attente-budget", "budget");
      audit(run.runId, "pause-budget", { etape: stepId });
      return;
    }
    if (verdict.kind === "differe") {
      const essais = (run.billRetries.get(stepId) ?? 0) + 1;
      run.billRetries.set(stepId, essais);
      if (essais > BILL_RETRY_MAX) {
        failStep(run, key, `envoi refusé par le cockpit (${verdict.raison})`, null);
        return;
      }
      if (store.steps.setState(key, "en-file")) emitStep(run, key, "en-file", null);
      audit(run.runId, "etape-differee", { etape: stepId, raison: verdict.raison, essai: essais });
      retryLater(run, stepId, key);
      return;
    }
    if (verdict.kind === "plafond") {
      audit(run.runId, "plafond", { etape: stepId, depense: verdict.depense, plafond: verdict.plafond });
      await eq.ports.guards.stopForCap(run.runId);
      return;
    }
    run.billRetries.delete(stepId);

    // (2) Session d'étape : plancher ETAPE posé par le serveur, écho vérifié (D-eq-08, spéc. §6 l.1032).
    const { agentRules } = verdict;
    const glob = truncateGlob();
    const floor = buildFloor("ETAPE", { agentRules, truncateGlob: glob });
    const floorSha256 = floorHash("ETAPE", { agentRules, truncateGlob: glob });
    const total = planSteps(run.flow).length;
    let created: unknown;
    try {
      created = await c11.client.request<unknown>("POST", "/session", {
        directory: run.directory,
        body: {
          parentID: run.rootId,
          title: `${planned.titre} (étape ${order.ordre} de l'équipe ${run.titre})`,
          metadata: { cockpit: "equipe", run: run.runId, etape: stepId, tentative: key.tentative, tour: key.tour },
          permission: floor,
        },
        timeoutMs: STEP_TIMEOUT_MS,
      });
    } catch (err) {
      failStep(run, key, `session d'étape non créée : ${errorMessage(err)}`, null);
      return;
    }
    const sessionId = isRecord(created) && typeof created.id === "string" && ID_RE.test(created.id) ? created.id : null;
    const echoOk = sessionId !== null && isRecord(created) && created.parentID === run.rootId && floorHolds(created.permission, floor);
    if (!echoOk) {
      warn("plancher d'étape non vérifié sur l'écho : session supprimée, rien n'est envoyé", { runId: run.runId, etape: stepId, sessionId });
      if (sessionId !== null) {
        try {
          await c11.client.request("DELETE", `/session/${enc(sessionId)}`, { directory: run.directory, timeoutMs: STEP_TIMEOUT_MS });
        } catch (err) {
          warn("session d'étape sans plancher non supprimée", { runId: run.runId, etape: stepId, error: errorMessage(err) });
        }
      }
      failStep(run, key, "plancher-etape", null);
      audit(run.runId, "plancher-refuse", { etape: stepId, tentative: key.tentative });
      return;
    }
    try {
      c11.sessions.upsert(created as OcSession);
      c11.sessions.setPlancher(sessionId, floorMark("ETAPE", floorSha256));
    } catch (err) {
      warn("session d'étape vérifiée mais non enregistrée", { runId: run.runId, etape: stepId, error: errorMessage(err) });
    }
    // Arrêt ou interruption pendant la création de la session : elle est supprimée et RIEN n'est envoyé (D-eq-05).
    if (closed || run.stopping) {
      await dropStepSession(run, stepId, sessionId);
      return;
    }

    // (3) Envoi : la consigne réelle est gardée en base (U2) et n'est JAMAIS journalisée (D-eq-26, un journal cite l'empreinte).
    const texte = stepMessage(run.flow, stepId, {
      runId: run.runId,
      tour: key.tour,
      tentative: key.tentative,
      equipe: run.titre,
      total,
      n: order.ordre,
      demande: run.demande ?? "",
      fichiers: run.fichiers,
      precisions: run.precisions,
      resultats: await resultsFor(run),
    });
    // Arrêt ou interruption pendant la lecture des résultats précédents : dernière attente avant l'envoi (D-eq-05).
    if (closed || run.stopping) {
      await dropStepSession(run, stepId, sessionId);
      return;
    }
    const empreinte = sha256(texte);
    store.steps.patch(key, {
      sessionId,
      agentFileSha256: planned.agentFileSha256,
      rulesSha256: planned.rulesSha256,
      floorSha256,
      rightLines: planned.droits,
      model: planned.model,
      variant: planned.variant,
      steps: planned.steps,
      messageText: texte,
      messageSha256: empreinte,
    });
    // Transition BLOQUANTE : un refus signifie que l'étape a déjà été close ailleurs (« non-lancee » par `stopped`,
    // « interrompue » par `interrupt`, « arretee », plafond). La fenêtre qui va de la place réservée à l'envoi est ainsi
    // fermée par construction : plus aucun `prompt_async` ne part après un arrêt, et la session créée est supprimée.
    if (!store.steps.setState(key, "en-cours")) {
      store.steps.patch(key, { sessionId: null });
      await dropStepSession(run, stepId, sessionId);
      return;
    }
    emitStep(run, key, "en-cours", sessionId);
    const watch = watchStep(run, key, sessionId);
    const ref = modelRef(planned.model);
    const end = c11.configQueue.beginBilled();
    try {
      await c11.client.request("POST", `/session/${enc(sessionId)}/prompt_async`, {
        directory: run.directory,
        body: {
          agent: planned.assistant,
          ...(ref ? { model: ref } : {}),
          ...(planned.variant ? { variant: planned.variant } : {}),
          parts: [{ type: "text", text: texte }],
        },
        timeoutMs: STEP_TIMEOUT_MS,
      });
    } catch (err) {
      watch.settle();
      failStep(run, key, `envoi à l'étape en échec : ${errorMessage(err)}`, sessionId);
      return;
    } finally {
      end();
    }
    audit(run.runId, "etape-envoyee", { etape: stepId, tentative: key.tentative, sessionId, empreinte });

    // (4) Attente, puis (5) lecture et (6) enregistrement.
    await watch.done;
    await settleStep(run, key, watch);
  };

  /** Résultats disponibles pour le message d'une étape ; `stepMessage` ne transmet que ceux de `receivedFrom` (T4). */
  const resultsFor = async (run: RunMemory): Promise<StepResult[]> => {
    const rows = lastRows(run.runId, run.tour);
    const lite = c11.catalog.lite();
    const out: StepResult[] = [];
    for (const planned of planSteps(run.flow)) {
      const row = rows.get(planned.stepId);
      if (!row || row.state !== "terminee") continue;
      const texte = run.resultats.get(planned.stepId) ?? (await readResult(run, row)) ?? row.result_excerpt ?? "";
      out.push({
        stepId: planned.stepId,
        titre: row.titre,
        assistant: row.agent,
        ia: row.model === null ? "" : modelName(row.model, lite),
        texte,
        corrige: run.corriges.has(planned.stepId) || row.correction_sha256 !== null,
      });
    }
    return out;
  };

  /** Résultat complet d'une étape terminée, relu dans sa session quand la mémoire a été perdue (redémarrage, relance). */
  const readResult = async (run: RunMemory, row: StepRow): Promise<string | null> => {
    if (row.session_id === null) return null;
    try {
      const messages = await c11.client.request<unknown>("GET", `/session/${enc(row.session_id)}/message`, {
        directory: run.directory,
        query: { limit: STEP_MESSAGE_LIMIT },
        timeoutMs: STEP_TIMEOUT_MS,
      });
      const last = lastAssistantOf(messages);
      if (!last) return null;
      const texte = textOf(last.parts);
      run.resultats.set(row.step_id, texte);
      return texte;
    } catch (err) {
      warn("résultat d'étape non relu", { runId: run.runId, etape: row.step_id, error: errorMessage(err) });
      return null;
    }
  };

  const lastAssistantOf = (messages: unknown): { info: Record<string, unknown>; parts: unknown } | null => {
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const entry: unknown = messages[i];
      if (!isRecord(entry)) continue;
      const info = isRecord(entry.info) ? entry.info : null;
      if (info?.role === "assistant") return { info, parts: entry.parts };
    }
    return null;
  };

  /** Coût de la session d'étape : somme de `usage.cost` (ME-7), une fois la ligne du dernier message écrite par le processeur. */
  const stepCost = async (sessionId: string, lastMessageId: string | null): Promise<number> => {
    const deadline = now() + usageWaitMs;
    while (lastMessageId !== null && now() < deadline) {
      const found = c11.db.prepare("SELECT 1 AS present FROM usage WHERE message_id = ?").get(lastMessageId) as { present: number } | undefined;
      if (found) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, USAGE_POLL_MS);
        timer.unref?.();
      });
    }
    const row = c11.db.prepare("SELECT COALESCE(SUM(cost), 0) AS cost FROM usage WHERE session_id = ?").get(sessionId) as { cost: number };
    return row.cost;
  };

  /**
   * (5) Lecture et (6) enregistrement. Ordre imposé par ME-6 : l'abandon est lu AVANT le test « texte vide », car un message
   * arrêté porte à la fois du texte et `MessageAbortedError`.
   */
  const settleStep = async (run: RunMemory, key: StepKey, watch: StepWatch): Promise<void> => {
    const row = store.steps.get(key);
    if (!row) return;
    // Étape déjà close par un arrêt, une interruption ou le plafond : rien à enregistrer de plus.
    if (row.state !== "en-cours" && row.state !== "attente-accord" && row.state !== "en-file") return;
    const planned = plannedOf(run, key.stepId);
    const steps = planned?.steps ?? row.steps;
    // ME-7 : compter TOUS les messages d'assistant (limit ≥ steps + 1), jamais seulement les vingt derniers.
    const limit = Math.max(STEP_MESSAGE_LIMIT, (steps ?? 0) + 1);
    let messages: unknown = [];
    try {
      messages = await c11.client.request<unknown>("GET", `/session/${enc(watch.sessionId)}/message`, {
        directory: run.directory,
        query: { limit },
        timeoutMs: STEP_TIMEOUT_MS,
      });
    } catch (err) {
      failStep(run, key, `réponse de l'étape illisible : ${errorMessage(err)}`, watch.sessionId);
      return;
    }
    const assistants = Array.isArray(messages) ? messages.filter((entry) => isRecord(entry) && isRecord(entry.info) && entry.info.role === "assistant") : [];
    const last = lastAssistantOf(messages);
    const info = last?.info ?? null;
    const texte = last ? textOf(last.parts) : "";
    const error = info && isRecord(info.error) ? info.error : null;
    const errorName = typeof error?.name === "string" ? error.name : null;
    const errorData = error && isRecord(error.data) ? error.data : null;
    const errorText = typeof errorData?.message === "string" ? errorData.message : null;
    const tronquee = steps !== null && steps > 0 && assistants.length >= steps;
    const cost = await stepCost(watch.sessionId, watch.lastAssistant);

    let state: TeamStepState = "terminee";
    let cause: string | null = null;
    if (errorName === "MessageAbortedError") {
      // ME-6 : abandon lu en premier ; demandé par le cockpit (arrêt) ou venu d'ailleurs (rechargement d'opencode).
      state = run.stopping ? "arretee" : "interrompue";
      cause = run.stopping ? "vous" : "rechargement";
    } else if (errorName !== null || watch.sessionError !== null) {
      state = "echec";
      cause = errorText ?? watch.sessionError ?? errorName ?? "erreur";
    } else if (texte.trim().length === 0) {
      state = "echec";
      cause = "L'étape n'a rien rendu.";
    }

    // Extrait : le magasin masque puis coupe à 2 000 caractères (couper d'abord laisserait passer le début d'un secret).
    store.steps.patch(key, { cost, tronquee, resultExcerpt: texte });
    if (state === "terminee") run.resultats.set(key.stepId, texte);
    store.steps.setState(key, state, { ...(cause === null ? {} : { cause: cleanCause(cause) }), at: now() });
    store.runs.patch(run.runId, { cost: store.spentOfRun(run.runId) });
    emitStep(run, key, state, watch.sessionId);
    audit(run.runId, "etape-finie", {
      etape: key.stepId,
      tentative: key.tentative,
      etat: state,
      cout: cost,
      tronquee,
      empreinte: row.message_sha256,
    });
  };

  // --- Livraison --------------------------------------------------------------------------------------------------------------

  const deliver = async (run: RunMemory): Promise<void> => {
    const livrable = deliverable(run.flow, flowState(run));
    if (livrable !== null) {
      try {
        const messageId = await inject(run, "resultat", livrable.texte);
        if (messageId !== null) store.runs.patch(run.runId, { resultMessageId: messageId });
        audit(run.runId, "livraison", { etape: livrable.etapeSource, messageId });
      } catch (err) {
        // Injection refusée par opencode : carte seule et [Ajouter à la conversation] (D-eq-14).
        warn("résultat non injecté : carte seule", { runId: run.runId, error: errorMessage(err) });
        audit(run.runId, "injection-refusee", { genre: "resultat" });
      }
    }
    setRunState(run, "terminee");
    // La racine n'est jamais passée « occupée » : les Archives puis le classement sont prévenus à la main.
    try {
      await c11.archive.refresh(run.rootId);
    } catch (err) {
      warn("archive non rafraîchie après l'équipe", { runId: run.runId, error: errorMessage(err) });
    }
    try {
      eq.classifier.onIdle(run.rootId);
    } catch (err) {
      warn("classement non prévenu après l'équipe", { runId: run.runId, error: errorMessage(err) });
    }
  };

  // --- Continuer --------------------------------------------------------------------------------------------------------------

  const refusal = (status: RunnerRefusal["status"], code: TeamErrorCode, details?: Record<string, unknown>): RunnerRefusal => ({
    ok: false,
    status,
    code,
    ...(details ? { details } : {}),
  });

  const continueRun = async (runId: string, body: TeamContinueBody, confirmed: boolean): Promise<TeamRunView | RunnerRefusal> => {
    const row = store.runs.get(runId);
    if (!row) return refusal(404, "not-found");
    if (!row.state.startsWith("attente-")) return refusal(409, "etat-incompatible");
    const precision = typeof body.precision === "string" ? body.precision : null;
    const correction = typeof body.correction === "string" ? body.correction : null;
    if ((precision !== null && precision.length > FLOW_LIMITS.precision) || (correction !== null && correction.length > FLOW_LIMITS.relaisCaracteres)) {
      return refusal(409, "invalid");
    }
    if (row.state === "attente-budget" && !confirmed) return refusal(409, "budget-guard");
    const run = runs.get(runId) ?? reattach(runId);
    if (!run) return refusal(404, "not-found");
    // Instantané perdu (redémarrage du cockpit) : aucune étape ne peut repartir sans lui. La feuille ré-estime, puis relance
    // (L37c) ; rien n'est envoyé ni facturé en attendant, et aucune étape n'échoue faute d'instantané.
    if (run.plan === null && [...lastRows(runId, run.tour).values()].some((step) => step.state === "prevue" || step.state === "en-file")) {
      return refusal(409, "estimation-perimee");
    }

    if (precision !== null && precision.trim().length > 0) {
      run.precisions.push(precision);
      store.runs.patch(runId, { precisions: run.precisions });
      audit(runId, "precision", { longueur: precision.length }, "vous");
    }
    if (correction !== null) {
      const cible = dernierResultat(run);
      if (cible) {
        const avant = run.resultats.get(cible.etape) ?? cible.texte;
        run.resultats.set(cible.etape, correction);
        run.corriges.add(cible.etape);
        store.steps.patch(keyOf(run, cible.etape), { correctionSha256: sha256(correction), resultExcerpt: correction });
        audit(runId, "correction", { etape: cible.etape, avant: sha256(avant), apres: sha256(correction) }, "vous");
      }
    }
    if (row.state === "attente-budget") store.runs.patch(runId, { confirmations: { ...parseConfirmations(runId), budget: true } });
    if (row.state === "attente-verification" && row.cause === "pause" && run.pauseBloc !== null) {
      run.pausesFranchies.push(run.pauseBloc);
      run.pauseBloc = null;
    }
    audit(runId, "reprise", { depuis: row.state }, "vous");
    // Pause du contrôle de fraîcheur : `recheck` est refait, et l'équipe reste en pause tant qu'il échoue (raison mise à jour).
    // La réponse n'attend QUE ce contrôle : la boucle part derrière, sur la même file, et la feuille suit la progression par
    // les événements. Sans cela, [Continuer] resterait ouvert jusqu'à la fin de toute l'équipe.
    if (run.attenteFraicheur) {
      await schedule(run, async () => {
        if (await prepareRun(run, { injecter: true })) void schedule(run, () => tick(run));
      });
      return view(runId) ?? refusal(404, "not-found");
    }
    if (!setRunState(run, "en-cours")) return refusal(409, "etat-incompatible");
    void schedule(run, () => tick(run));
    return view(runId) ?? refusal(404, "not-found");
  };

  // --- Résultats ajoutés à la conversation (D-eq-22) --------------------------------------------------------------------------

  /** Résultats complets relus dans les sessions d'étape quand la mémoire a été perdue (redémarrage). */
  const hydrateResults = async (run: RunMemory): Promise<void> => {
    for (const row of lastRows(run.runId, run.tour).values()) {
      if (row.state !== "terminee" || run.resultats.has(row.step_id)) continue;
      const texte = (await readResult(run, row)) ?? row.result_excerpt;
      if (texte !== null) run.resultats.set(row.step_id, texte);
    }
  };

  const addResults = async (runId: string): Promise<{ messageId: string } | RunnerRefusal> => {
    const row = store.runs.get(runId);
    if (!row) return refusal(404, "not-found");
    if (row.result_message_id !== null) return refusal(409, "deja-ajoute");
    if (!ADD_RESULTS_STATES.has(row.state)) return refusal(409, "etat-incompatible");
    const run = runs.get(runId) ?? reattach(runId);
    if (!run) return refusal(404, "not-found");
    await hydrateResults(run);
    const complet = deliverable(run.flow, flowState(run));
    const partiel = complet === null ? partialDeliverable(run.flow, flowState(run)) : null;
    if (complet === null && partiel === null) return refusal(409, "etat-incompatible");
    try {
      const messageId = await inject(run, complet ? "resultat" : "resultats-partiels", complet?.texte ?? partiel?.texte ?? "");
      if (messageId === null) return refusal(409, "etat-incompatible");
      store.runs.patch(runId, { resultMessageId: messageId });
      audit(runId, "resultats-ajoutes", { messageId }, "vous");
      return { messageId };
    } catch (err) {
      warn("résultats non ajoutés à la conversation", { runId, error: errorMessage(err) });
      return refusal(409, "etat-incompatible");
    }
  };

  // --- Relance ----------------------------------------------------------------------------------------------------------------

  const relaunch = async (runId: string, plan: RunPlan): Promise<TeamRunView | RunnerRefusal> => {
    const row = store.runs.get(runId);
    if (!row) return refusal(404, "not-found");
    const run = runs.get(runId) ?? reattach(runId);
    if (!run) return refusal(404, "pas-relancable");
    // D-eq-27 : sans demande reconstituable EN BASE, la relance passe par la saisie — même porte que la vue et que la route
    // (rebuildRunBody, L37c). La mémoire du processus, qui garde la demande telle que l'utilisateur l'a écrite, sert ensuite.
    const enBase = readRequest(runId);
    if (enBase === null) return refusal(409, "pas-relancable");
    const request = run.demande === null ? enBase : { demande: run.demande, fichiers: run.fichiers };
    await hydrateResults(run);
    // Transition d'abord (table de T4 : « terminee » et « arretee » sont finaux) : rien n'est touché en mémoire ni en base
    // quand elle est refusée. Une pause (dont celle d'un redémarrage) et les états en échec admettent une nouvelle tentative ;
    // la route de relance (L37c) pose sa propre condition, plus étroite.
    if (!store.runs.setState(runId, "preparation")) return refusal(409, "pas-relancable");
    run.demande = request.demande;
    run.fichiers = request.fichiers;
    run.plan = plan;
    run.flow = plan.flow;
    run.stopping = false;
    run.changement = null;
    run.billRetries.clear();
    store.runs.patch(runId, { estimateSha256: plan.estimateSha256, plafond: plan.plafond, endedAt: null });
    // Nouvelle tentative (nouvelle ligne, nouvelle session) pour chaque étape non terminée ; les terminées ne sont pas refacturées.
    const rows = lastRows(runId, run.tour);
    for (const planned of planSteps(run.flow)) {
      const previous = rows.get(planned.stepId);
      if (previous?.state === "terminee") continue;
      const tentative = (previous?.tentative ?? 0) + 1;
      run.tentatives.set(planned.stepId, tentative);
      const step = plan.etapes.find((entry) => entry.stepId === planned.stepId);
      store.steps.create({
        runId,
        stepId: planned.stepId,
        tour: run.tour,
        tentative,
        ordre: planned.ordre,
        blocIndex: planned.blocIndex,
        titre: step?.titre ?? previous?.titre ?? planned.stepId,
        agent: step?.assistant ?? previous?.agent ?? "",
        state: "prevue",
      });
    }
    runs.set(runId, run);
    audit(runId, "relance", { estimation: plan.estimateSha256 }, "vous");
    emitRun(run);
    // Contrôle de fraîcheur avant toute session d'étape ; la demande a déjà été injectée au premier lancement.
    void schedule(run, () => startRun(run, { injecter: false }));
    return view(runId) ?? refusal(404, "not-found");
  };

  // --- Reprise au démarrage ---------------------------------------------------------------------------------------------------

  /** Mémoire d'un lancement que ce processus ne suit pas encore (redémarrage, relance, arrêt). */
  const reattach = (runId: string): RunMemory | null => {
    const found = runs.get(runId);
    if (found) return found;
    const run = memoryFromRow(runId);
    if (!run) return null;
    const request = readRequest(runId);
    if (request) {
      run.demande = request.demande;
      run.fichiers = request.fichiers;
    }
    // Pauses déjà franchies : tout bloc « pause » placé avant une étape terminée l'a été.
    const rows = lastRows(runId, run.tour);
    const franchies = new Set<string>();
    for (const planned of planSteps(run.flow)) {
      if (rows.get(planned.stepId)?.state !== "terminee") continue;
      for (const bloc of run.flow.blocs.slice(0, planned.blocIndex)) if (bloc.type === "pause") franchies.add(bloc.id);
    }
    run.pausesFranchies = [...franchies];
    for (const [stepId, row] of rows) run.tentatives.set(stepId, row.tentative);
    runs.set(runId, run);
    return run;
  };

  const recover = async (): Promise<void> => {
    const rows = store.runs.activeCount() === 0 ? [] : activeRunIds();
    for (const id of rows) {
      const row = store.runs.get(id);
      if (!row) continue;
      const run = reattach(id);
      if (!run) continue;
      const steps = lastRows(id, run.tour);
      const envoyees = [...steps.values()].filter((step) => step.session_id !== null);
      const occupees = [...steps.values()].filter((step) => step.state === "en-cours" || step.state === "attente-accord");
      // Équipe en préparation, ou en pause de fraîcheur sans aucune étape envoyée : rien n'a été envoyé ni facturé (D-eq-27).
      if (row.state === "preparation" || (row.state === "attente-verification" && row.cause === "changement" && envoyees.length === 0)) {
        setRunState(run, "interrompue", "redemarrage-cockpit");
        audit(id, "redemarrage", { etat: row.state, envoyees: envoyees.length });
        continue;
      }
      if (row.state !== "en-cours") continue;
      if (occupees.length === 0) {
        run.attenteFraicheur = false;
        setRunState(run, "attente-verification", "redemarrage-cockpit");
        audit(id, "redemarrage", { etat: row.state, occupees: 0 });
        continue;
      }
      // Rattachement : surveillance seulement, AUCUNE nouvelle étape (ni POST /session, ni prompt_async).
      audit(id, "redemarrage", { etat: row.state, occupees: occupees.length });
      for (const step of occupees) {
        const key: StepKey = { runId: id, stepId: step.step_id, tour: step.tour, tentative: step.tentative };
        run.tentatives.set(step.step_id, step.tentative);
        run.inflight.add(step.step_id);
        const watch = watchStep(run, key, step.session_id as string);
        void schedule(run, async () => {
          try {
            await watch.done;
            await settleStep(run, key, watch);
          } finally {
            run.inflight.delete(step.step_id);
          }
          if (run.inflight.size === 0 && store.runs.get(id)?.state === "en-cours") {
            run.attenteFraicheur = false;
            setRunState(run, "attente-verification", "redemarrage-cockpit");
          }
        });
      }
      void probeSessions();
    }
  };

  /** Identifiants des lancements qui travaillent ou attendent (lecture seule ; le magasin n'expose pas cette liste). */
  const activeRunIds = (): string[] => {
    const placeholders = RECOVERABLE_STATES.map((_, index) => `:etat${index}`).join(", ");
    const params = Object.fromEntries(RECOVERABLE_STATES.map((state, index) => [`etat${index}`, state]));
    const rows = c11.db.prepare(`SELECT id FROM team_runs WHERE state IN (${placeholders}) ORDER BY created_at, id`).all(params) as unknown as Array<{ id: string }>;
    return rows.map((row) => row.id);
  };

  const onConnection = (data: { connected: boolean }): void => {
    if (!data.connected || closed || watches.size === 0) return;
    // Même vérification qu'au démarrage, sans mettre en pause : les sessions d'étape finies pendant la coupure sont relevées.
    void probeSessions();
  };

  // --- Arrêt, interruption, fermeture ------------------------------------------------------------------------------------------

  const runsOfRoot = (rootId: string): RunMemory[] =>
    store.runs
      .activeOfRoot(rootId)
      .map((row) => runs.get(row.id) ?? reattach(row.id))
      .filter((run): run is RunMemory => run !== null);

  const causeOfStop = (cause: StopCause): TeamRunCause => {
    switch (cause) {
      case "equipe":
        return "equipe";
      case "plafond-cout":
      case "plafond-delegations":
        return "plafond";
      case "rechargement":
        return "rechargement";
      default:
        return "vous";
    }
  };

  const stopRequested = (rootId: string, cause: StopCause): void => {
    for (const run of runsOfRoot(rootId)) {
      run.stopping = true;
      for (const timer of run.timers) clearTimeout(timer);
      run.timers.clear();
      audit(run.runId, "arret-demande", { cause });
    }
  };

  const stopped = (rootId: string, cause: StopCause, result: StopResult | null): void => {
    for (const run of runsOfRoot(rootId)) {
      for (const [stepId, row] of lastRows(run.runId, run.tour)) {
        const key: StepKey = { runId: run.runId, stepId, tour: row.tour, tentative: row.tentative };
        if (row.state === "prevue" || row.state === "en-file") {
          if (store.steps.setState(key, "non-lancee", { cause: "vous" })) emitStep(run, key, "non-lancee", row.session_id);
        } else if (row.state === "en-cours" || row.state === "attente-accord") {
          if (store.steps.setState(key, "arretee", { cause: causeOfStop(cause) })) emitStep(run, key, "arretee", row.session_id);
        }
      }
      const depense = store.spentOfRun(run.runId);
      const row = store.runs.get(run.runId);
      const plafond = row?.plafond ?? null;
      // Arrêt au plafond, trois signes. Le premier est le CHEMIN NOMINAL : `guards.stopForCap` mémorise la cause en base AVANT
      // l'arrêt (D-eq-05, contrat de team-run-guards.ts), puis arrête l'arbre au nom de l'ÉQUIPE — le décorateur transmet donc
      // « equipe », et le plafond posé par `recheckStep` s'arrête AVANT dépassement, donc la dépense n'y suffit pas. Les deux
      // autres : la cause transmise par le décorateur (« plafond-cout », « plafond-delegations ») et la dépense arrivée au
      // plafond, quand l'arrêt vient d'ailleurs pendant la dernière étape.
      const parPlafond = causeOfStop(cause) === "plafond" || row?.cause === "plafond" || (plafond !== null && depense >= plafond);
      store.runs.patch(run.runId, { cost: depense });
      setRunState(run, parPlafond ? "plafond" : "arretee", parPlafond ? "plafond" : causeOfStop(cause));
      audit(run.runId, "arret", { cause, arretees: result === null ? null : result.aborted.length, plafond: parPlafond });
      for (const watch of [...watches.values()]) if (watch.run.runId === run.runId) watch.settle();
    }
  };

  const interrupt = (runId: string, cause: TeamRunCause): void => {
    const run = runs.get(runId) ?? reattach(runId);
    if (!run) return;
    run.stopping = true;
    for (const [stepId, row] of lastRows(runId, run.tour)) {
      const key: StepKey = { runId, stepId, tour: row.tour, tentative: row.tentative };
      if (row.state === "en-cours" || row.state === "attente-accord" || row.state === "en-file") {
        if (store.steps.setState(key, "interrompue", { cause })) emitStep(run, key, "interrompue", row.session_id);
      } else if (row.state === "prevue") {
        if (store.steps.setState(key, "non-lancee", { cause })) emitStep(run, key, "non-lancee", null);
      }
    }
    setRunState(run, "interrompue", cause);
    audit(runId, "interruption", { cause });
    for (const watch of [...watches.values()]) if (watch.run.runId === runId) watch.settle();
  };

  const closeRun = (runId: string): TeamRunView | RunnerRefusal => {
    const row = store.runs.get(runId);
    if (!row) return refusal(404, "not-found");
    if (row.state !== "echec" && row.state !== "interrompue" && row.state !== "plafond") return refusal(409, "etat-incompatible");
    const run = runs.get(runId) ?? reattach(runId);
    if (!run) return refusal(404, "not-found");
    setRunState(run, "arretee", "vous");
    audit(runId, "fermeture", {}, "vous");
    return view(runId) ?? refusal(404, "not-found");
  };

  // --- Lectures ---------------------------------------------------------------------------------------------------------------

  const stepOf = (sessionId: string): { runId: string; stepId: string } | null => {
    if (!ID_RE.test(sessionId)) return null;
    const row = c11.db.prepare("SELECT run_id, step_id FROM team_run_steps WHERE session_id = ? LIMIT 1").get(sessionId) as
      | { run_id: string; step_id: string }
      | undefined;
    return row ? { runId: row.run_id, stepId: row.step_id } : null;
  };

  /**
   * D-eq-06 : vrai tant qu'une équipe est « preparation » ou « en-cours » (entre deux étapes et entre POST /session et
   * prompt_async compris) ou qu'une étape est « en-file », « en-cours » ou « attente-accord » ; faux pendant les pauses.
   * Aucun lancement suivi : aucune lecture (le prédicat est appelé à chaque garde de rechargement).
   */
  const stepsBusy = (): boolean => {
    for (const run of runs.values()) {
      // Étapes que l'ordonnanceur a en main : de la place réservée jusqu'à l'enregistrement de la fin, POST /session et
      // prompt_async compris. Une pause décidée par une étape pendant que ses sœurs travaillent ne rend donc PAS la main.
      if (run.inflight.size > 0) return true;
      const row = store.runs.get(run.runId);
      if (row) run.state = row.state;
      if (BUSY_RUN_STATES.has(run.state)) return true;
    }
    return false;
  };

  const dispose = (): void => {
    closed = true;
    if (poll !== null) {
      clearInterval(poll);
      poll = null;
    }
    for (const run of runs.values()) {
      for (const timer of run.timers) clearTimeout(timer);
      run.timers.clear();
    }
    for (const watch of [...watches.values()]) watch.settle();
  };

  return {
    launch,
    continue: continueRun,
    view,
    runsOf: (rootId) =>
      store.runs
        .ofRoot(rootId)
        .map((row) => view(row.id))
        .filter((entry): entry is TeamRunView => entry !== null),
    runOfStepSession: (sessionId) => {
      const found = stepOf(sessionId);
      return found ? view(found.runId) : null;
    },
    activeRunOf: (rootId) => {
      const row = store.runs.activeOfRoot(rootId)[0];
      return row ? { runId: row.id, state: row.state } : null;
    },
    stepOf,
    stepsBusy,
    stopRequested,
    stopped,
    interrupt,
    relaunch,
    close: closeRun,
    addResults,
    onEvent,
    recover,
    onConnection,
    dispose,
  };
}

// --- Port neutre et module ------------------------------------------------------------------------------------------------------

/** Refus « a-venir », un objet neuf à chaque appel (l'appelant peut le compléter). */
const aVenir = (): RunnerRefusal => ({ ok: false, status: 409, code: "a-venir" });

export function neutralRunner(): TeamRunnerPort {
  return {
    launch: () => Promise.reject(new EqPortUnavailableError("runner")),
    continue: async () => aVenir(),
    view: () => null,
    runsOf: () => [],
    runOfStepSession: () => null,
    activeRunOf: () => null,
    stepOf: () => null,
    stepsBusy: () => false,
    stopRequested: () => undefined,
    stopped: () => undefined,
    interrupt: () => undefined,
    relaunch: async () => aVenir(),
    close: () => aVenir(),
    addResults: async () => aVenir(),
  };
}

/**
 * Module `teamRunner`. Les options ne servent qu'aux TESTS (horloge, délais raccourcis) : la production passe par
 * `teamRunnerModule`, qui garde les valeurs du dépôt ; aucune n'est lue d'une variable d'environnement.
 */
export function createTeamRunnerModule(options: TeamRunnerOptions = {}): EqModule {
  return {
    name: "teamRunner",
    install(reg, eq) {
      const runner = createTeamRunner(eq, options);
      eq.ports.runner = runner;
      reg.derivation({ name: "teamRunner", onEvent: (event) => runner.onEvent(event) });
      reg.hub("opencode.connection", (data) => runner.onConnection(data));
      reg.startup(() => runner.recover());
      reg.routes("team-runs", (app) => registerTeamRunRoutes(app, eq));
      // Étapes en cours ou en file : la garde de rechargement répond « busy » (composé dans c11.reloadBusy par apply).
      reg.reloadBusy(() => eq.ports.runner.stepsBusy());
    },
  };
}

export const teamRunnerModule: EqModule = createTeamRunnerModule();
