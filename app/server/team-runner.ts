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
//
// ITÉRATION 5b (L42b) : exécution des formes « relecture » et « aiguillage » posées par L42a, transmissions `recoit: {etapes}` et
// méthodes des étapes. Points qui tiennent ici :
// - D-5-14, CONFIRMÉE par la mesure MC5-2 : à partir du tour 2, une relecture ne crée AUCUNE session — le même `session_id` reçoit
//   un nouveau `prompt_async`, avec sa garde et son plafond comme toute autre étape. Il n'y a donc ni repli « session neuve avec
//   la version précédente encadrée », ni correction à faire : une session au repos garde tout son historique et rend la dernière
//   ligne `VERDICT:` à l'octet. Une ligne `team_run_steps` par (étape, tour), toutes sur la même session, `verdict` enregistré ;
// - spéc. l.772 : le choix d'un aiguillage n'est JAMAIS tranché par l'autonomie ni par un crochet. L'aiguilleur terminé met le
//   lancement en « attente-choix » et rien ne repart avant VOTRE `POST …/continue {choix}` ou `{aucun: true}` ;
// - A4 (Q5 (b) du plan it4) : la reprise de fraîcheur d'avant chaque étape couvre aussi les méthodes — une méthode devenue
//   inconnue, ou désormais posée dans le fichier de l'assistant, met l'équipe en pause « À vérifier » SANS aucun envoi. Le
//   contrôle relit le fichier d'agent EN LOCAL (`studio.get`), donc sans aucune requête à opencode ;
// - le cockpit n'ajoute jamais de méthode à une étape qui n'en déclare pas.
import { createHash, randomUUID } from "node:crypto";
import { billRefusal } from "./config-queue.ts";
// <gf3:consignes-etape> début : magasin des consignes de « Revoir » (3D, L28d), appelé par la jonction U2 des étapes (GF3)
import { createConsignesStore } from "./consignes-store.ts";
// </gf3:consignes-etape> fin
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
import { METHODS } from "./methods-catalogue.ts";
import type { OcGlobalEvent, OcSession } from "./opencode.ts";
import { resolvePrice } from "./pricing.ts";
import { redactSecrets } from "./redact.ts";
import { registerTeamRunRoutes } from "./routes-team-runs.ts";
import { floorHash } from "./session-floor-service.ts";
import { modelName, type Rule, truncateGlob } from "./shared/assistant-rules.ts";
import type { StopCause, StopResult } from "./shared/cockpit-event-types.ts";
import { type FlowEstimateContext, suiteEstimate } from "./shared/flow-estimate.ts";
import {
  DELIVERABLE_TEXTS,
  deliverable,
  type FlowAction,
  type FlowDeliverable,
  type FlowState,
  injectionText,
  type InjectionKind,
  nextActions,
  partialDeliverable,
  readChoice,
  readVerdict,
  requestFromStepMessage,
  type StepResult,
  stepMessage,
  tourKey,
} from "./shared/flow.ts";
import { ID_RE } from "./shared/ids.ts";
import { methodIdsIn } from "./shared/methods.ts";
import { buildFloor, canonicalRules, floorHolds, floorMark } from "./shared/session-floors.ts";
import { choixMaxDe, FLOW_LIMITS, planSteps, toursDe } from "./shared/team-limits.ts";
import { pauseChangement, remplir, TEXTES } from "./shared/team-texts.ts";
import type {
  Flow,
  FlowBlock,
  FlowStep,
  PlannedRole,
  StepAssistant,
  StepChoice,
  // StepVerdict de T4 nomme déjà, plus bas, le verdict de la REVÉRIFICATION de chaque étape : celui du relecteur (L42a) est
  // renommé ici, pour que les deux restent lisibles côte à côte.
  StepVerdict as VerdictRelecteur,
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
/** Raison d'un aiguilleur affichée dans la carte de choix (5b, C §9.5) : masquée, bornée, jamais une consigne. */
const RAISON_MAX = 300;
/** Titre de repli quand l'équipe du plan n'est plus installée (son déroulé reste celui du lancement). */
const TEAM_TITLE_FALLBACK = "Équipe";

const P = TEXTES.partout;

/** Lancements dont le prédicat de rechargement répond « occupé » (D-eq-06) ; les pauses « attente-* » en sont absentes. */
const BUSY_RUN_STATES: ReadonlySet<TeamRunState> = new Set<TeamRunState>(["preparation", "en-cours"]);

// Les états d'étape qui occupent (« en-file », « en-cours », « attente-accord », D-eq-06) n'ont pas de liste à part : une étape
// est dans `run.inflight` de sa place réservée à l'enregistrement de sa fin, et un nouvel essai différé laisse son lancement
// « en-cours ». `stepsBusy()` lit ces deux signaux.

/**
 * États d'un lancement que la reprise au démarrage examine (les autres sont finis).
 * « attente-choix » (5b) en est ABSENT volontairement : un redémarrage du cockpit laisse la pause de choix telle quelle, aucune
 * étape n'est lancée et la carte est rendue depuis la base (spéc. l.772 — rien ne part sans votre réponse).
 */
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

// --- Lecture du déroulé (5b) ----------------------------------------------------------------------------------------------------

/**
 * Étapes déclarées d'un bloc, avec leur rôle. `planSteps` (T4, L42a) reste la fonction de référence pour l'ORDRE et `receivedFrom`
 * pour les relais : rien n'est réécrit ici. Cette lecture-ci sert à ce que l'ordre d'estimation ne donne pas — le texte d'une
 * étape (`methodes`), le bloc auquel elle appartient, et les spécialistes qu'un aiguillage peut lancer AU-DELÀ de `choixMax`.
 */
function etapesDuBloc(bloc: FlowBlock): Array<{ step: FlowStep; role: PlannedRole }> {
  switch (bloc.type) {
    case "etape":
      return [{ step: bloc.etape, role: "etape" }];
    case "avis":
      return [...bloc.avis.map((step) => ({ step, role: "avis" as const })), { step: bloc.synthese, role: "synthese" as const }];
    case "relecture":
      return [
        { step: bloc.auteur, role: "redaction" },
        { step: bloc.relecteur, role: "relecture" },
      ];
    case "aiguillage":
      return [
        { step: bloc.aiguilleur, role: "aiguilleur" as const },
        ...(Array.isArray(bloc.specialistes) ? bloc.specialistes : []).map((step) => ({ step, role: "specialiste" as const })),
        ...(bloc.synthese ? [{ step: bloc.synthese, role: "synthese" as const }] : []),
      ];
    default:
      return [];
  }
}

/** Étape du déroulé, avec son bloc et son rôle ; null quand l'identifiant n'y est pas. */
function etapeDuDeroule(flow: Flow, stepId: string): { step: FlowStep; bloc: FlowBlock; role: PlannedRole } | null {
  for (const bloc of flow.blocs) {
    for (const { step, role } of etapesDuBloc(bloc)) if (step.id === stepId) return { step, bloc, role };
  }
  return null;
}

/**
 * Place de chaque étape DÉCLARÉE, sans doublon. `planSteps` rend le chemin d'ESTIMATION : une relecture y revient à chaque tour
 * (dédupliqué ici) et un aiguillage n'y compte que `choixMax` spécialistes, alors que l'exécution peut lancer n'importe lesquels
 * de la liste. Les spécialistes que le chemin maximal ne porte pas sont donc ajoutés derrière leurs frères, et les rangs sont
 * renumérotés. Pour un déroulé de l'itération 4, la liste est exactement celle de `planSteps`.
 */
function etapesDeclarees(flow: Flow): Array<{ stepId: string; blocId: string; blocIndex: number; ordre: number }> {
  const entrees: Array<{ stepId: string; blocId: string; blocIndex: number }> = [];
  const vues = new Set<string>();
  for (const planned of planSteps(flow)) {
    if (vues.has(planned.stepId)) continue;
    vues.add(planned.stepId);
    entrees.push({ stepId: planned.stepId, blocId: planned.blocId, blocIndex: planned.blocIndex });
  }
  flow.blocs.forEach((bloc, blocIndex) => {
    if (bloc.type !== "aiguillage") return;
    const specialistes = Array.isArray(bloc.specialistes) ? bloc.specialistes : [];
    const ids = new Set(specialistes.map((step) => step.id));
    let place = entrees.findLastIndex((entree) => entree.blocId === bloc.id && ids.has(entree.stepId)) + 1;
    for (const step of specialistes) {
      if (vues.has(step.id)) continue;
      vues.add(step.id);
      entrees.splice(place, 0, { stepId: step.id, blocId: bloc.id, blocIndex });
      place++;
    }
  });
  return entrees.map((entree, index) => ({ ...entree, ordre: index + 1 }));
}

/** Méthodes « consigne » du catalogue (L44a), par identifiant : le cockpit n'en ajoute jamais une que l'étape ne déclare pas. */
const METHODES_CONSIGNE = new Map(METHODS.filter((methode) => methode.kind === "consigne").map((methode) => [methode.id, methode]));

/**
 * Raison affichée sous la proposition d'un aiguilleur : sa réponse PRIVÉE de sa dernière ligne (le « CHOIX: … », qui est lu à
 * part par `readChoice`), masquée, sur une seule ligne, bornée à RAISON_MAX. C'est du texte d'IA : la carte le présente comme une
 * proposition à vérifier, jamais comme une consigne.
 */
function raisonDeLAiguilleur(texte: string): string {
  const lignes = texte.trimEnd().split("\n");
  if (lignes.length > 1) lignes.pop();
  return redactSecrets(lignes.join(" ")).replace(/\s+/gu, " ").trim().slice(0, RAISON_MAX);
}

/**
 * Choix CONFIRMÉ relu dans la colonne `choix` de l'aiguilleur : « aucun », ou la liste d'identifiants. La colonne reste vide tant
 * que vous n'avez pas répondu — la PROPOSITION de l'aiguilleur, elle, ne s'écrit jamais là (spéc. l.772 : rien ne se lance sans
 * votre réponse, donc une proposition ne doit jamais pouvoir passer pour une confirmation).
 */
function lireChoixConfirme(brut: string | null): string[] | "aucun" | null {
  if (brut === null || brut === "") return null;
  if (brut === "aucun") return "aucun";
  try {
    const value: unknown = JSON.parse(brut);
    if (!Array.isArray(value)) return null;
    const ids = value.filter((id): id is string => typeof id === "string" && id !== "");
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

// <c5:depot-fige>
/** Note « Relecture non conclue après {n} tours… » écrite par le cockpit : son nombre de tours se relit sur le gabarit. */
const [NON_CONCLUE_AVANT = "", NON_CONCLUE_APRES = ""] = DELIVERABLE_TEXTS.nonConclue.split("{n}");

/**
 * Grande fusion (GF4, A28 C6) : ce que le COCKPIT écrit dans un message de résultat, FIGÉ à son dépôt dans l'événement d'audit.
 * Codes et nombres seulement, jamais un texte de message (team_run_events) : genre, journal de relecture, et les deux notes
 * d'honnêteté. La vue le rend (`depot`) pour que la carte de CE message ne relise jamais l'état d'un lancement relancé depuis.
 */
function ecritAuDepot(genre: "resultat" | "resultats-partiels", livrable: FlowDeliverable | null): Record<string, string | number | boolean | null> {
  const notes = genre === "resultat" ? (livrable?.notes ?? []) : [];
  const conclue = notes.find((note) => note.startsWith(NON_CONCLUE_AVANT) && note.endsWith(NON_CONCLUE_APRES));
  const tours = conclue === undefined ? Number.NaN : Number(conclue.slice(NON_CONCLUE_AVANT.length, conclue.length - NON_CONCLUE_APRES.length));
  return {
    genre,
    journal: genre === "resultat" && livrable?.journal === true,
    nonRelue: notes.includes(DELIVERABLE_TEXTS.nonRelue),
    nonConclue: Number.isSafeInteger(tours) && tours > 0 ? tours : null,
  };
}

/** Dépôt figé du message `messageId`, relu dans les événements d'audit ; null pour un dépôt sans cette trace. */
function depotDesEvenements(events: readonly { kind: string; data: string }[], messageId: string | null): TeamRunView["depot"] | null {
  if (messageId === null) return null;
  for (const event of [...events].reverse()) {
    if (event.kind !== "livraison" && event.kind !== "resultats-ajoutes") continue;
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      continue;
    }
    if (!isRecord(data) || data.messageId !== messageId) continue;
    const genre = data.genre === "resultat" || data.genre === "resultats-partiels" ? data.genre : null;
    if (genre === null || typeof data.journal !== "boolean" || typeof data.nonRelue !== "boolean") return null;
    const tours = typeof data.nonConclue === "number" && Number.isSafeInteger(data.nonConclue) && data.nonConclue > 0 ? data.nonConclue : null;
    return { messageId, genre, journal: data.journal, nonRelue: data.nonRelue, nonConclue: tours };
  }
  return null;
}
// </c5:depot-fige>

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
  /**
   * Texte complet du résultat de chaque étape terminée (relais, livrable) ; relu dans la session si la mémoire a été perdue.
   * 5b : une relecture y range AUSSI chaque tour, sous la clé `tourKey(etape, tour)` ; la clé nue garde la dernière version.
   */
  resultats: Map<string, string>;
  corriges: Set<string>;
  pausesFranchies: string[];
  /** 5b : blocs « relecture » dont la pause d'avant la première relecture a été franchie (elle n'a pas de bloc « pause »). */
  pausesRelecture: string[];
  /** 5b : tour COURANT de chaque étape (1 partout, sauf les tours d'une relecture) ; remplace l'ancien `tour` du lancement. */
  tours: Map<string, number>;
  /** 5b : proposition LUE sur la dernière ligne de chaque aiguilleur ; null = choix illisible, rien n'est présélectionné. */
  proposes: Map<string, StepChoice | null>;
  /** 5b : raison donnée par l'aiguilleur, masquée et bornée : c'est la proposition d'une IA, à vérifier. */
  raisons: Map<string, string>;
  /** 5b : choix CONFIRMÉ par vous, par bloc d'aiguillage ; il est aussi écrit en base (colonne `choix` de l'aiguilleur). */
  choix: Map<string, string[] | "aucun">;
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
  // <c5:reprise-redemarrage>
  /**
   * Clôture 5b (D-5b-1) : étapes relues « en-file » après un redémarrage du cockpit. Leur nouvel essai était un minuteur de
   * l'ancien processus, perdu avec lui : l'ordonnanceur les reprend comme des étapes à lancer, sur LEUR ligne (même tour, même
   * tentative), qui n'a rien envoyé. Vide pour un lancement suivi par ce processus depuis son départ.
   */
  enFileOrphelines: Set<string>;
  // </c5:reprise-redemarrage>
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
  /** 5b : messages d'assistant vus DEPUIS CET ENVOI ; une session reprise en porte déjà des tours précédents (D-5-14). */
  assistants: Set<string>;
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

  /**
   * Ligne qui fait foi pour chaque étape : la DERNIÈRE écrite. L'itération 4 la cherchait dans le seul tour 1 ; depuis L42a, une
   * relecture repasse par la même étape à chaque tour, donc l'ordre de lecture est « tentative d'abord, puis tour » — une relance
   * repart au tour 1 avec une tentative plus grande (D-5-14), et elle doit l'emporter sur les tours de la tentative précédente.
   */
  const lastRows = (runId: string): Map<string, StepRow> => {
    const out = new Map<string, StepRow>();
    for (const row of store.steps.ofRun(runId)) {
      const kept = out.get(row.step_id);
      if (!kept || row.tentative > kept.tentative || (row.tentative === kept.tentative && row.tour >= kept.tour)) out.set(row.step_id, row);
    }
    return out;
  };

  /** Verdicts rendus dans chaque bloc « relecture », dans l'ordre des tours ; `null` = verdict illisible (colonne `verdict`). */
  const verdictsDesBlocs = (run: RunMemory): Record<string, (VerdictRelecteur | null)[]> => {
    const out: Record<string, (VerdictRelecteur | null)[]> = {};
    const derniere = new Map<string, StepRow>();
    for (const row of store.steps.ofRun(run.runId)) {
      const cle = `${row.step_id}\u0000${row.tour}`;
      const kept = derniere.get(cle);
      if (!kept || row.tentative >= kept.tentative) derniere.set(cle, row);
    }
    for (const bloc of run.flow.blocs) {
      if (bloc.type !== "relecture") continue;
      const tours: (VerdictRelecteur | null)[] = [];
      for (let tour = 1; ; tour++) {
        const row = derniere.get(`${bloc.relecteur.id}\u0000${tour}`);
        if (!row || row.state !== "terminee") break;
        tours.push(row.verdict === "a-reprendre" || row.verdict === "rien-a-reprendre" ? row.verdict : null);
      }
      out[bloc.id] = tours;
    }
    return out;
  };

  /** Choix CONFIRMÉ par vous pour chaque aiguillage : colonne `choix` de l'aiguilleur, écrite par `continue` seulement. */
  const choixConfirmes = (run: RunMemory): Record<string, string[] | "aucun"> => {
    const out: Record<string, string[] | "aucun"> = {};
    const rows = lastRows(run.runId);
    for (const bloc of run.flow.blocs) {
      if (bloc.type !== "aiguillage") continue;
      const confirme = run.choix.get(bloc.id) ?? lireChoixConfirme(rows.get(bloc.aiguilleur.id)?.choix ?? null);
      if (confirme !== null) out[bloc.id] = confirme;
    }
    return out;
  };

  const flowState = (run: RunMemory): FlowState => {
    const rows = lastRows(run.runId);
    const etapes: Record<string, TeamStepState> = {};
    for (const declaree of etapesDeclarees(run.flow)) {
      // <c5:reprise-redemarrage>
      // Une étape « en-file » dont le nouvel essai a été perdu avec l'ancien processus est rendue à l'ordonnanceur « prevue » :
      // sans cela, elle comptait comme une étape active, et le lancement attendait pour toujours un essai qui ne viendrait pas.
      const enregistre = rows.get(declaree.stepId)?.state ?? "prevue";
      const etat: TeamStepState = enregistre === "en-file" && run.enFileOrphelines.has(declaree.stepId) ? "prevue" : enregistre;
      // </c5:reprise-redemarrage>
      etapes[declaree.stepId] = run.inflight.has(declaree.stepId) ? "en-cours" : etat;
    }
    const resultats: Record<string, string> = {};
    for (const [cle, texte] of run.resultats) resultats[cle] = texte;
    return {
      etapes,
      pausesFranchies: run.pausesFranchies,
      resultats,
      tours: Object.fromEntries(toursTermines(run.runId)),
      verdicts: verdictsDesBlocs(run),
      choix: choixConfirmes(run),
      pausesRelecture: run.pausesRelecture,
    };
  };

  const keyOf = (run: RunMemory, stepId: string): StepKey => ({
    runId: run.runId,
    stepId,
    tour: run.tours.get(stepId) ?? 1,
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
    const rows = lastRows(run.runId);
    let last: StepRow | null = null;
    for (const declaree of etapesDeclarees(run.flow)) {
      const row = rows.get(declaree.stepId);
      if (row?.state === "terminee") last = row;
    }
    if (!last) return null;
    return { etape: last.step_id, titre: last.titre, texte: run.resultats.get(last.step_id) ?? last.result_excerpt ?? "" };
  };

  /** Première étape non terminée du chemin (libellé d'une pause de budget). */
  const prochaineEtape = (run: RunMemory): { stepId: string; titre: string } | null => {
    const rows = lastRows(run.runId);
    for (const declaree of etapesDeclarees(run.flow)) {
      const row = rows.get(declaree.stepId);
      if (row?.state === "terminee") continue;
      // <c5:prochaine-etape>
      // Clôture 5b, tour 3 : un spécialiste (ou une synthèse) écarté par votre choix est « Non choisi », état final — il ne
      // partira jamais. Sans ce saut, la pause « garde-fou budgétaire » nommait une étape que vous n'aviez pas retenue (P3).
      if (row?.state === "non-choisi") continue;
      // </c5:prochaine-etape>
      return { stepId: declaree.stepId, titre: row?.titre ?? declaree.stepId };
    }
    return null;
  };

  /** Message écrit dans le bloc « pause » du déroulé ; à défaut, le titre de la pause. */
  const pauseMessage = (run: RunMemory): string => {
    const bloc = run.flow.blocs.find((block) => block.type === "pause" && block.id === run.pauseBloc);
    return bloc && bloc.type === "pause" && bloc.message.trim().length > 0 ? bloc.message : P.pauses.verification.titre;
  };

  /**
   * Bloc « aiguillage » qui attend VOTRE choix : son aiguilleur a fini et aucun choix n'est confirmé. Lu dans la BASE, jamais
   * dans la mémoire du processus, pour qu'un redémarrage du cockpit rende la même pause (rien n'est lancé en attendant).
   */
  const blocEnChoix = (run: RunMemory): Extract<FlowBlock, { type: "aiguillage" }> | null => {
    const rows = lastRows(run.runId);
    const confirmes = choixConfirmes(run);
    for (const bloc of run.flow.blocs) {
      if (bloc.type !== "aiguillage") continue;
      if (rows.get(bloc.aiguilleur.id)?.state !== "terminee") continue;
      if (!Object.hasOwn(confirmes, bloc.id)) return bloc;
    }
    return null;
  };

  /** Vue de la pause de choix (L42a) : les spécialistes de la liste, la proposition lue, la raison masquée et le maximum. */
  const choixView = (run: RunMemory, base: Omit<TeamPauseView, "kind" | "message">): TeamPauseView | null => {
    const bloc = blocEnChoix(run);
    if (!bloc) return null;
    const propose = run.proposes.get(bloc.id) ?? null;
    const retenus = propose === null || propose === "aucun" ? [] : propose.ids;
    return {
      ...base,
      blocId: bloc.id,
      kind: "choix",
      message: P.pauses.choix.titre,
      choix: (Array.isArray(bloc.specialistes) ? bloc.specialistes : []).map((step) => ({
        stepId: step.id,
        titre: step.titre,
        propose: retenus.includes(step.id),
      })),
      raison: run.raisons.get(bloc.id) ?? "",
      choixMax: choixMaxDe(bloc),
    };
  };

  /**
   * Contexte d'estimation du chemin restant, SANS aucune lecture d'opencode : IA et variante relues dans les lignes d'étapes (ou
   * dans l'instantané du lancement), tarifs du catalogue déjà chargé, moyennes observées de la base.
   */
  const estimateContext = (run: RunMemory): FlowEstimateContext => {
    const rows = lastRows(run.runId);
    const lite = c11.catalog.lite();
    const assistants = new Map<string, StepAssistant>();
    for (const planned of etapesDeclarees(run.flow)) {
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
    const tentativeMax = new Map<string, number>();
    for (const row of store.steps.ofRun(runId)) {
      tentativeMax.set(row.step_id, Math.max(tentativeMax.get(row.step_id) ?? 0, row.tentative));
      const cle = `${row.step_id}\u0000${row.tour}`;
      const kept = derniere.get(cle);
      if (!kept || row.tentative >= kept.tentative) derniere.set(cle, row);
    }
    const out = new Map<string, number>();
    for (const row of derniere.values()) {
      // Une relance repart du tour 1 avec une tentative de plus (D-5-14) : les tours de la tentative précédente ne comptent plus,
      // sinon une relecture relancée croirait ses deux tours déjà faits et ne relirait plus rien.
      if (row.state !== "terminee" || row.tentative !== tentativeMax.get(row.step_id)) continue;
      out.set(row.step_id, (out.get(row.step_id) ?? 0) + 1);
    }
    return out;
  };

  const suiteOf = (run: RunMemory): { typique: number; maximum: number } => {
    const rows = lastRows(run.runId);
    const finis = toursTermines(run.runId);
    // UNE entrée par étape, jamais une par passage : `suiteEstimate` additionne les comptes de tours qu'on lui donne.
    const etapes: Array<{ stepId: string; state: TeamStepState; tours: number }> = [];
    for (const declaree of etapesDeclarees(run.flow)) {
      etapes.push({
        stepId: declaree.stepId,
        state: rows.get(declaree.stepId)?.state ?? ("prevue" as TeamStepState),
        tours: finis.get(declaree.stepId) ?? 0,
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
    // 5b : le choix d'un aiguillage attend VOTRE réponse (spéc. l.772). La pause est rendue depuis la base, donc elle survit à un
    // redémarrage du cockpit — et rien n'est lancé tant qu'elle dure.
    if (state === "attente-choix") return choixView(run, base);
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
    const run: RunMemory = {
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
      pausesRelecture: [],
      tours: new Map(),
      proposes: new Map(),
      raisons: new Map(),
      choix: new Map(),
      tentatives: new Map(),
      state: row.state,
      changement: null,
      pauseBloc: null,
      attenteFraicheur: false,
      stopping: false,
      inflight: new Set(),
      // <c5:reprise-redemarrage>
      enFileOrphelines: new Set(),
      // </c5:reprise-redemarrage>
      billRetries: new Map(),
      timers: new Set(),
      chain: Promise.resolve(),
    };
    relirePropositions(run);
    // <c5:reprise-redemarrage>
    restaurerApresRedemarrage(run, row.state, row.cause);
    // </c5:reprise-redemarrage>
    return run;
  };

  /**
   * Propositions d'aiguilleur et raisons relues dans la BASE (5b) : après un redémarrage du cockpit, la pause de choix doit
   * rendre exactement ce qu'elle rendait avant. La proposition est relue dans l'audit (identifiants seulement, jamais un texte
   * de message) et la raison dans l'extrait déjà masqué du résultat de l'aiguilleur, privé de sa dernière ligne (le « CHOIX: »).
   */
  const relirePropositions = (run: RunMemory): void => {
    const aiguillages = run.flow.blocs.filter((bloc): bloc is Extract<FlowBlock, { type: "aiguillage" }> => bloc.type === "aiguillage");
    if (aiguillages.length === 0) return;
    for (const event of store.events.ofRun(run.runId)) {
      if (event.kind !== "aiguillage-propose") continue;
      let data: unknown;
      try {
        data = JSON.parse(event.data || "{}");
      } catch {
        continue;
      }
      if (!isRecord(data) || typeof data.bloc !== "string" || typeof data.ids !== "string") continue;
      if (data.ids === "aucun") run.proposes.set(data.bloc, "aucun");
      else {
        const ids = data.ids.split(",").filter((id) => id !== "");
        run.proposes.set(data.bloc, ids.length > 0 ? { ids } : null);
      }
    }
    const rows = lastRows(run.runId);
    for (const bloc of aiguillages) {
      const extrait = rows.get(bloc.aiguilleur.id)?.result_excerpt;
      if (typeof extrait === "string" && extrait !== "") run.raisons.set(bloc.id, raisonDeLAiguilleur(extrait));
    }
  };

  // <c5:reprise-redemarrage>
  /**
   * Clôture 5b (D-5b-1) : ce que la mémoire d'un lancement relit en BASE après un redémarrage du cockpit, pour que la pause rende
   * la même chose qu'avant et que VOTRE réponse la fasse repartir :
   * - les pauses déjà franchies : tout bloc « pause » placé avant une étape que l'ordonnanceur a ATTEINTE — une ligne, quelle
   *   que soit sa tentative, qui n'est ni « prevue » ni « non-lancee » (terminée, mais aussi en cours, en file ou écartée : la
   *   pause d'avant a donc reçu votre réponse) ; la pause d'avant la première relecture, dès que le relecteur a travaillé une
   *   fois (lu ici, et non plus dans `reattach` seul, pour que la VUE d'un lancement qu'aucune exécution de ce processus ne suit
   *   les connaisse aussi). L'itération 4 ne comptait que les étapes TERMINÉES : une étape encore au travail au redémarrage,
   *   rattachée puis finie, laissait la pause d'avant non franchie, et elle était redemandée ;
   * - le bloc qui attend (`pauseBloc`) d'une pause « vérifier » : sans lui, la carte perdait le message écrit dans le bloc, et
   *   [Continuer] ne notait pas la pause franchie — l'ordonnanceur la redemandait aussitôt, sans fin ;
   * - les étapes restées « en-file » : leur nouvel essai était un minuteur de l'ancien processus (`enFileOrphelines`).
   * Aucune requête : tout est lu dans la base.
   */
  const restaurerApresRedemarrage = (run: RunMemory, state: TeamRunState, cause: TeamRunCause | null): void => {
    const rows = lastRows(run.runId);
    const atteintes = new Set(
      store.steps
        .ofRun(run.runId)
        .filter((row) => row.state !== "prevue" && row.state !== "non-lancee")
        .map((row) => row.step_id),
    );
    const franchies = new Set<string>();
    for (const declaree of etapesDeclarees(run.flow)) {
      if (!atteintes.has(declaree.stepId)) continue;
      for (const bloc of run.flow.blocs.slice(0, declaree.blocIndex)) if (bloc.type === "pause") franchies.add(bloc.id);
    }
    run.pausesFranchies = [...franchies];
    const finis = toursTermines(run.runId);
    run.pausesRelecture = [];
    for (const bloc of run.flow.blocs) {
      if (bloc.type !== "relecture") continue;
      const dejaEnvoye = (rows.get(bloc.relecteur.id)?.session_id ?? null) !== null;
      if ((finis.get(bloc.relecteur.id) ?? 0) > 0 || dejaEnvoye) run.pausesRelecture.push(bloc.id);
    }
    for (const [stepId, row] of rows) if (row.state === "en-file") run.enFileOrphelines.add(stepId);
    if (state === "attente-verification" && cause === "pause") {
      const premiere = nextActions(run.flow, flowState(run), { simultanees: concurrentSteps() })[0];
      if (premiere !== undefined && "pause" in premiere) run.pauseBloc = premiere.pause;
    }
  };

  /**
   * VOTRE réponse à cette pause lancerait-elle un appel facturé ? Elle est JOUÉE à blanc par l'ordonnanceur lui-même
   * (`nextActions`, sans rien écrire) : la pause « vérifier » est notée franchie, « Aucun ne convient » est posé sur le bloc en
   * choix, et toute autre pause repart telle quelle, comme le fait `continueRun`. Vrai dès que la première décision de
   * l'ordonnanceur LANCE une étape. Retenir des spécialistes les lance toujours ; « Aucun ne convient » ne lance rien, sauf
   * l'étape d'un bloc suivant (D-5-13). Une ligne d'étape ne suffit pas à le dire : le tour suivant d'une relecture n'a pas
   * encore de ligne tant qu'il n'est pas parti.
   */
  const lanceraitUnAppel = (run: RunMemory, state: TeamRunState, cause: string | null, reponse: { aucun: boolean }): boolean => {
    let etat = flowState(run);
    if (state === "attente-choix") {
      const bloc = blocEnChoix(run);
      if (bloc === null) return false;
      if (!reponse.aucun) return true;
      etat = { ...etat, choix: { ...(etat.choix ?? {}), [bloc.id]: "aucun" } };
    } else if (state === "attente-verification" && cause === "pause" && run.pauseBloc !== null) {
      const franchie = run.pauseBloc;
      etat =
        run.flow.blocs.find((bloc) => bloc.id === franchie)?.type === "relecture"
          ? { ...etat, pausesRelecture: [...(etat.pausesRelecture ?? []), franchie] }
          : { ...etat, pausesFranchies: [...(etat.pausesFranchies ?? []), franchie] };
    }
    return nextActions(run.flow, etat, { simultanees: concurrentSteps() }).some((action) => "lancer" in action);
  };

  /**
   * La pause attend-elle une NOUVELLE estimation ? Oui quand l'instantané du lancement est perdu (il ne vit qu'en mémoire : après
   * un redémarrage du cockpit, la mémoire est relue en base sans lui) ET que votre réponse lancerait un appel facturé.
   * `aucunLibre` : pause de choix où « Aucun ne convient » ne lancerait rien. `possible` : la demande est reconstituable en base
   * (D-eq-27), donc POST …/relancer peut l'accepter.
   */
  const repriseDe = (run: RunMemory, state: TeamRunState, cause: string | null): NonNullable<TeamPauseView["reestimation"]> | null => {
    if (run.plan !== null || !state.startsWith("attente-") || !lanceraitUnAppel(run, state, cause, { aucun: false })) return null;
    return {
      aucunLibre: state === "attente-choix" && !lanceraitUnAppel(run, state, cause, { aucun: true }),
      possible: readRequest(run.runId) !== null,
    };
  };

  /** Pause, avec la ré-estimation qu'elle attend ; le champ est ABSENT sinon (la forme de la vue de l'itération 4 est gardée). */
  const avecReprise = (pause: TeamPauseView | null, reprise: NonNullable<TeamPauseView["reestimation"]> | null): TeamPauseView | null =>
    pause === null || reprise === null ? pause : { ...pause, reestimation: reprise };
  // </c5:reprise-redemarrage>

  const view = (runId: string): TeamRunView | null => {
    const row = store.runs.get(runId);
    const base = row ? store.runs.view(runId) : null;
    if (!row || !base) return null;
    // Lancement non suivi par ce processus : mémoire de lecture seulement, jamais ajoutée au registre (stepsBusy reste vrai).
    const run = runs.get(runId) ?? memoryFromRow(runId);
    if (!run) return base;
    const lite = c11.catalog.lite();
    // 5b : `verdict` et `choix` sont des colonnes que la vue du magasin ne rend pas (team-store.ts appartient à L37s) ; elles
    // sont ajoutées ici, ligne par ligne, sur la clé complète (étape, tour, tentative).
    const brut = new Map(store.steps.ofRun(runId).map((line) => [`${line.step_id}\u0000${line.tour}\u0000${line.tentative}`, line]));
    // <c5:blocs-prevus>
    // Bornes DÉCLARÉES des blocs répétables : le Déroulé d'équipe en a besoin pour dire « Prévu : jusqu'à {n} », que les lignes
    // enregistrées ne portent pas (elles ne comptent que ce qui a eu lieu). Lues dans le déroulé du lancement, jamais ailleurs.
    const blocs: NonNullable<TeamRunView["blocs"]> = [];
    run.flow.blocs.forEach((bloc, index) => {
      if (bloc.type === "relecture") blocs.push({ index, type: "relecture", toursMax: toursDe(bloc) });
      // `specialistes` : le nombre DÉCLARÉ, pour que le Déroulé n'ait plus à deviner où est la synthèse (elle n'existe qu'à
      // partir de deux spécialistes possibles, et un aiguillage neuf n'en a pas).
      else if (bloc.type === "aiguillage") {
        blocs.push({ index, type: "aiguillage", choixMax: choixMaxDe(bloc), specialistes: (Array.isArray(bloc.specialistes) ? bloc.specialistes : []).length });
      }
    });
    // </c5:blocs-prevus>
    // <c5:depot-fige>
    const depot = depotDesEvenements(store.events.ofRun(runId), row.result_message_id);
    // </c5:depot-fige>
    return {
      ...base,
      ...(blocs.length === 0 ? {} : { blocs }),
      // <c5:depot-fige>
      ...(depot === null ? {} : { depot }),
      // </c5:depot-fige>
      steps: base.steps.map((step) => {
        const line = brut.get(`${step.stepId}\u0000${step.tour}\u0000${step.tentative}`);
        const verdict = line?.verdict === "a-reprendre" || line?.verdict === "rien-a-reprendre" ? line.verdict : null;
        const choix = lireChoixConfirme(line?.choix ?? null);
        return {
          ...step,
          ia: { ...step.ia, label: step.ia.model === null ? null : modelName(step.ia.model, lite) },
          ...(line?.verdict === undefined || line.verdict === null ? {} : { verdict }),
          ...(choix === null ? {} : { choix }),
        };
      }),
      // <c5:reprise-redemarrage>
      pause: avecReprise(pauseView(run, row.state, row.cause), repriseDe(run, row.state, row.cause)),
      // </c5:reprise-redemarrage>
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
      assistants: new Set<string>(),
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
        if (typeof info.id === "string") {
          watch.lastAssistant = info.id;
          watch.assistants.add(info.id);
        }
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
    // UNE ligne par étape déclarée, au tour 1. L'itération 4 suivait `planSteps`, qui depuis L42a rend un élément PAR PASSAGE
    // (une relecture y revient à chaque tour) et n'en rend aucun pour les spécialistes au-delà de `choixMax` : la ligne d'un tour
    // suivant est créée quand ce tour part, et un spécialiste que l'estimation ne comptait pas garde quand même sa ligne.
    for (const declaree of etapesDeclarees(plan.flow)) {
      const step = plan.etapes.find((entry) => entry.stepId === declaree.stepId);
      const declaration = etapeDuDeroule(plan.flow, declaree.stepId);
      store.steps.create({
        runId,
        stepId: declaree.stepId,
        tour: 1,
        tentative: 1,
        ordre: declaree.ordre,
        blocIndex: declaree.blocIndex,
        titre: step?.titre ?? declaration?.step.titre ?? declaree.stepId,
        agent: step?.assistant ?? declaration?.step.assistant ?? "",
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
      pausesRelecture: [],
      tours: new Map(),
      proposes: new Map(),
      raisons: new Map(),
      choix: new Map(),
      tentatives: new Map(),
      state: "preparation",
      changement: null,
      pauseBloc: null,
      attenteFraicheur: false,
      stopping: false,
      inflight: new Set(),
      // <c5:reprise-redemarrage>
      enFileOrphelines: new Set(),
      // </c5:reprise-redemarrage>
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
    const lancer = actions.filter((action): action is Extract<FlowAction, { lancer: string }> => "lancer" in action);
    if (lancer.length > 0) {
      // Place réservée AVANT toute attente : deux passages de l'ordonnanceur ne lancent jamais la même étape deux fois.
      for (const action of lancer) run.inflight.add(action.lancer);
      // 5b : `tour` et `reprendreSession` viennent de l'ordonnanceur (L42a). Un tour repris ne crée AUCUNE session (D-5-14).
      await Promise.all(lancer.map((action) => runStep(run, action.lancer, { tour: action.tour ?? 1, reprendreSession: action.reprendreSession === true })));
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
    // 5b : l'aiguilleur a fini, VOUS confirmez son choix (spéc. l.772). Aucun spécialiste ne part avant votre réponse, et ni
    // l'autonomie ni un crochet ne tranchent à votre place : la seule sortie est POST …/continue {choix} ou {aucun: true}.
    if ("choix" in first) {
      run.pauseBloc = first.choix;
      run.attenteFraicheur = false;
      setRunState(run, "attente-choix", null);
      audit(run.runId, "attente-choix", { bloc: first.choix });
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

  /** 5b : méthodes de l'étape, ou l'écart qui met l'équipe en pause « À vérifier » avant tout envoi (A4). */
  type MethodesDEtape = { ok: true; blocs: { titre: string; bloc: string }[] } | { ok: false; code: TeamErrorCode; details: Record<string, unknown> };

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

  /**
   * Méthodes d'une étape, résolues par le catalogue de L44a, avec la REPRISE DE FRAÎCHEUR d'avant chaque étape (A4) : une méthode
   * devenue inconnue du catalogue, ou désormais PRÉSENTE dans le fichier de l'assistant (posée après l'estimation), met l'équipe
   * en pause « À vérifier » — l'étape la recevrait deux fois, une fois par sa consigne durable, une fois par le message.
   * Le fichier d'agent est relu EN LOCAL (`studio.get`, comme au pré-lancement) : aucune requête à opencode. Fichier illisible :
   * rien n'est supposé, l'étape part avec ses méthodes (le pré-lancement les a déjà validées).
   * Une étape sans `methodes` ne fait AUCUNE lecture et ne reçoit AUCUNE méthode : le cockpit n'en ajoute jamais.
   */
  const methodesDeLEtape = async (run: RunMemory, stepId: string, assistant: string): Promise<MethodesDEtape> => {
    const declaration = etapeDuDeroule(run.flow, stepId);
    const demandees = Array.isArray(declaration?.step.methodes) ? declaration.step.methodes : [];
    if (demandees.length === 0) return { ok: true, blocs: [] };
    const blocs: { titre: string; bloc: string }[] = [];
    for (const id of demandees) {
      const methode = typeof id === "string" ? METHODES_CONSIGNE.get(id) : undefined;
      if (!methode) return { ok: false, code: "equipe-invalide", details: { raison: "methode-inconnue", methode: String(id), etape: stepId } };
      blocs.push({ titre: methode.titre, bloc: methode.bloc });
    }
    let corps: string | null = null;
    try {
      corps = (await c11.studio.get("agents", assistant, { type: "global" }))?.body ?? null;
    } catch (err) {
      warn("fichier d'un assistant d'étape illisible : méthodes laissées telles quelles", { runId: run.runId, etape: stepId, error: errorMessage(err) });
    }
    if (corps !== null) {
      const deja = new Set(methodIdsIn(corps).map((entree) => entree.id));
      const double = demandees.find((id) => typeof id === "string" && deja.has(id));
      if (double !== undefined) {
        return { ok: false, code: "equipe-invalide", details: { raison: "methode-deja-posee", methode: double, etape: stepId, nom: assistant } };
      }
    }
    return { ok: true, blocs };
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

  /** 5b : ce qui distingue un passage d'un autre pour la MÊME étape (relecture, D-5-14). Par défaut : tour 1, session neuve. */
  interface StepPass {
    tour: number;
    reprendreSession: boolean;
  }

  const retryLater = (run: RunMemory, stepId: string, key: StepKey, pass: StepPass): void => {
    const timer = setTimeout(() => {
      run.timers.delete(timer);
      if (closed || run.stopping) return;
      if (store.steps.get(key)?.state !== "en-file") return;
      void schedule(run, async () => {
        run.inflight.add(stepId);
        try {
          await runStepInner(run, stepId, key, pass);
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

  const runStep = async (run: RunMemory, stepId: string, pass: StepPass): Promise<void> => {
    // 5b : le tour courant de l'étape fait partie de sa clé (une ligne par (étape, tour), D-5-14).
    run.tours.set(stepId, pass.tour);
    // <c5:reprise-redemarrage>
    // L'étape en file orpheline repart sur sa ligne : si elle retombe « en-file », c'est un nouvel essai VIVANT (retryLater) qui la
    // tient, et l'ordonnanceur ne doit plus la relancer lui-même.
    run.enFileOrphelines.delete(stepId);
    // </c5:reprise-redemarrage>
    const key = keyOf(run, stepId);
    try {
      await runStepInner(run, stepId, key, pass);
    } catch (err) {
      warn("étape en échec", { runId: run.runId, etape: stepId, error: errorMessage(err) });
      failStep(run, key, errorMessage(err), store.steps.get(key)?.session_id ?? null);
    } finally {
      run.inflight.delete(stepId);
    }
  };

  /** Session déjà ouverte pour cette étape, à reprendre au tour suivant (D-5-14) : la dernière ligne qui en porte une. */
  const sessionDeLEtape = (run: RunMemory, stepId: string, tentative: number): string | null => {
    let trouvee: StepRow | null = null;
    for (const row of store.steps.ofRun(run.runId)) {
      if (row.step_id !== stepId || row.tentative !== tentative || row.session_id === null) continue;
      if (!trouvee || row.tour >= trouvee.tour) trouvee = row;
    }
    return trouvee?.session_id ?? null;
  };

  const runStepInner = async (run: RunMemory, stepId: string, key: StepKey, pass: StepPass): Promise<void> => {
    const planned = plannedOf(run, stepId);
    // Rang affiché dans le message : le passage de CE tour sur le chemin maximal, sinon la place déclarée de l'étape (un
    // spécialiste que le chemin d'estimation ne compte pas en a une, `planSteps` non).
    const passages = planSteps(run.flow);
    const declarees = etapesDeclarees(run.flow);
    const order = passages.find((entry) => entry.stepId === stepId && entry.tour === key.tour) ?? declarees.find((entry) => entry.stepId === stepId);
    if (!planned || !order) {
      failStep(run, key, "étape inconnue de l'instantané du lancement", null);
      return;
    }
    // Ligne du tour : celle du tour 1 existe depuis le lancement, celle d'un tour suivant est créée ici (une par (étape, tour)).
    if (!store.steps.get(key)) {
      const place = declarees.find((entry) => entry.stepId === stepId);
      store.steps.create({
        runId: key.runId,
        stepId,
        tour: key.tour,
        tentative: key.tentative,
        ordre: place?.ordre ?? order.ordre,
        blocIndex: place?.blocIndex ?? order.blocIndex,
        titre: planned.titre,
        agent: planned.assistant,
        state: "prevue",
      });
    }

    // (0) Méthodes de l'étape et leur fraîcheur (5b, A4) : AUCUNE requête à opencode, et aucune lecture quand l'étape n'en
    // déclare pas. Contrôlées avant tout le reste : un refus tardif ne doit jamais coûter une lecture de plus.
    const methodes = await methodesDeLEtape(run, stepId, planned.assistant);
    if (closed || run.stopping) return;
    if (!methodes.ok) {
      run.changement = { code: methodes.code, details: methodes.details };
      run.attenteFraicheur = true;
      setRunState(run, "attente-verification", "changement");
      audit(run.runId, "pause-methodes", {
        etape: stepId,
        raison: String(methodes.details.raison ?? ""),
        methode: String(methodes.details.methode ?? ""),
      });
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
      retryLater(run, stepId, key, pass);
      return;
    }
    if (verdict.kind === "plafond") {
      audit(run.runId, "plafond", { etape: stepId, depense: verdict.depense, plafond: verdict.plafond });
      await eq.ports.guards.stopForCap(run.runId);
      return;
    }
    run.billRetries.delete(stepId);

    // (2) Session d'étape : plancher ETAPE posé par le serveur, écho vérifié (D-eq-08, spéc. §6 l.1032).
    // 5b, D-5-14 (CONFIRMÉE par MC5-2) : au tour 2 et suivants d'une relecture, AUCUN `POST /session` — la session du tour 1 est
    // reprise telle quelle, avec tout son historique. Son plancher a déjà été posé et vérifié à sa création.
    const { agentRules } = verdict;
    const glob = truncateGlob();
    const floor = buildFloor("ETAPE", { agentRules, truncateGlob: glob });
    const floorSha256 = floorHash("ETAPE", { agentRules, truncateGlob: glob });
    const total = Math.max(passages.length, declarees.length);
    const reprise = pass.reprendreSession ? sessionDeLEtape(run, stepId, key.tentative) : null;
    let sessionId: string | null = reprise;
    if (reprise === null) {
      // Garde de sûreté : une reprise demandée sans session à reprendre (tentative neuve dont le tour précédent est resté sur
      // la tentative d'avant) repart en session NEUVE au tour demandé. Un échec ici arrêtait tout le lancement sur un message
      // interne — « session du tour précédent introuvable » —, qu'aucune relance ne pouvait dépasser.
      if (pass.reprendreSession) warn("session du tour précédent introuvable : le tour repart en session neuve", { runId: run.runId, etape: stepId, tour: key.tour });
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
      const creee = isRecord(created) && typeof created.id === "string" && ID_RE.test(created.id) ? created.id : null;
      const echoOk = isRecord(created) && created.parentID === run.rootId && floorHolds(created.permission, floor);
      if (creee === null || !echoOk) {
        warn("plancher d'étape non vérifié sur l'écho : session supprimée, rien n'est envoyé", { runId: run.runId, etape: stepId, sessionId: creee });
        if (creee !== null) {
          try {
            await c11.client.request("DELETE", `/session/${enc(creee)}`, { directory: run.directory, timeoutMs: STEP_TIMEOUT_MS });
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
        c11.sessions.setPlancher(creee, floorMark("ETAPE", floorSha256));
      } catch (err) {
        warn("session d'étape vérifiée mais non enregistrée", { runId: run.runId, etape: stepId, error: errorMessage(err) });
      }
      sessionId = creee;
    }
    if (sessionId === null) {
      failStep(run, key, "session d'étape introuvable", null);
      return;
    }
    const session = sessionId;
    // Une session REPRISE n'est jamais supprimée par un abandon : elle porte les tours déjà faits, et l'arrêt de l'arbre s'en
    // charge (stopTree). Seule une session créée pour CE tour est jetée quand rien ne part.
    const abandonner = async (): Promise<void> => {
      if (reprise === null) await dropStepSession(run, stepId, session);
    };
    // Arrêt ou interruption pendant la création de la session : elle est supprimée et RIEN n'est envoyé (D-eq-05).
    if (closed || run.stopping) {
      await abandonner();
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
      methodes: methodes.blocs,
    });
    // Arrêt ou interruption pendant la lecture des résultats précédents : dernière attente avant l'envoi (D-eq-05).
    if (closed || run.stopping) {
      await abandonner();
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
      if (reprise === null) store.steps.patch(key, { sessionId: null });
      await abandonner();
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
    // <gf3:consignes-etape> début : jonction U2 × équipes (grande fusion GF3, seul propriétaire ; plan it5 §8.4, plan it4 §9.3,
    // plan it3 D-3d-30). Endroit UNIQUE où le runner envoie le message d'une étape : une fois le message accepté par opencode,
    // sa copie est gardée pour « Revoir » par l'API publique du magasin des consignes de la 3D, jamais par une seconde lecture
    // de `message_text`. Même borne, même masquage (avant la coupe), même mention de troncature, même purge avec la conversation
    // (arbre de `root_id`) que les consignes de délégation. Clé refusée par ID_RE (enregistrer rend « cle-invalide ») : rien
    // d'écrit. Jamais journalisée : un échec n'est signalé que par son code, sans le texte, et n'arrête jamais l'étape.
    try {
      const ecriture = createConsignesStore(c11.db).enregistrer({
        rootId: run.rootId,
        parent: run.rootId,
        enfant: sessionId,
        callId: `etape-${key.tour}-${key.tentative}-${sessionId}`,
        brut: texte,
        at: now(),
      });
      if (ecriture === "limite" || ecriture === "cle-invalide") {
        warn("consigne d'étape non gardée pour « Revoir »", { runId: run.runId, etape: stepId, raison: ecriture });
      }
    } catch (err) {
      warn("consigne d'étape non gardée pour « Revoir »", { runId: run.runId, etape: stepId, error: errorMessage(err) });
    }
    // </gf3:consignes-etape> fin
    audit(run.runId, "etape-envoyee", { etape: stepId, tentative: key.tentative, sessionId, empreinte });

    // (4) Attente, puis (5) lecture et (6) enregistrement.
    await watch.done;
    await settleStep(run, key, watch);
  };

  /**
   * Résultats disponibles pour le message d'une étape ; `stepMessage` ne transmet que ceux de `receivedFrom` (T4) — qui lit
   * `recoit`, y compris la forme `{etapes}` de la 5b : les résultats de TOUTES les étapes terminées nommées y sont donc portés,
   * quel que soit leur bloc, et pas seulement ceux du bloc précédent.
   */
  const resultsFor = async (run: RunMemory): Promise<StepResult[]> => {
    const rows = lastRows(run.runId);
    const lite = c11.catalog.lite();
    const out: StepResult[] = [];
    for (const declaree of etapesDeclarees(run.flow)) {
      const row = rows.get(declaree.stepId);
      if (!row || row.state !== "terminee") continue;
      const texte = run.resultats.get(declaree.stepId) ?? (await readResult(run, row)) ?? row.result_excerpt ?? "";
      out.push({
        stepId: declaree.stepId,
        titre: row.titre,
        assistant: row.agent,
        ia: row.model === null ? "" : modelName(row.model, lite),
        texte,
        corrige: run.corriges.has(declaree.stepId) || row.correction_sha256 !== null,
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
   * 5b : fin de réponse d'un relecteur ou d'un aiguilleur, lue sur la DERNIÈRE ligne (L42a).
   * - relecteur : le verdict est écrit dans la colonne `verdict` de la ligne du tour ; illisible → colonne vide, et
   *   l'ordonnanceur le traite comme « à reprendre » (le cockpit ne suppose jamais qu'une relecture s'est bien passée) ;
   * - aiguilleur : la PROPOSITION est gardée en mémoire et inscrite à l'audit (identifiants seulement) pour qu'un redémarrage
   *   rende la même carte. Elle n'est JAMAIS écrite dans la colonne `choix`, réservée à VOTRE confirmation (spéc. l.772).
   */
  const enregistrerVerdictOuChoix = (run: RunMemory, key: StepKey, texte: string): void => {
    const declaration = etapeDuDeroule(run.flow, key.stepId);
    if (!declaration) return;
    const { bloc, role } = declaration;
    if (bloc.type === "relecture" && role === "relecture") {
      const verdict = readVerdict(texte);
      store.steps.patch(key, { verdict });
      audit(run.runId, "verdict", { bloc: bloc.id, tour: key.tour, verdict: verdict ?? "illisible" });
      return;
    }
    if (bloc.type === "aiguillage" && role === "aiguilleur") {
      const specialistes = Array.isArray(bloc.specialistes) ? bloc.specialistes : [];
      const propose = readChoice(texte, specialistes, choixMaxDe(bloc));
      run.proposes.set(bloc.id, propose);
      run.raisons.set(bloc.id, raisonDeLAiguilleur(texte));
      const ids = propose === null ? "" : propose === "aucun" ? "aucun" : propose.ids.join(",");
      audit(run.runId, "aiguillage-propose", { bloc: bloc.id, ids });
    }
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
    // « Tronquée » ne vaut que pour CE tour : une session reprise (relecture, D-5-14) porte aussi les messages des tours
    // précédents, que la lecture rend tous. Au tour 1 le compte reste celui de l'itération 4, à l'unité près.
    const vus = key.tour > 1 ? watch.assistants.size : assistants.length;
    const tronquee = steps !== null && steps > 0 && vus >= steps;
    // Coût DE CE TOUR. `stepCost` rend l'usage de la session depuis son début et, au tour 2 d'une relecture, la même session
    // porte déjà le tour 1 (D-5-14) : ce que les tours précédents de la MÊME étape, de la MÊME tentative et de la MÊME session
    // ont déjà porté est retranché. Sans cela, la colonne « Coût » du Déroulé — une ligne par tour — additionnait deux fois les
    // tours précédents et ne retombait plus sur le bilan du lancement (spentOfRun, qui somme par session et ne compte rien deux
    // fois).
    const sessionUsd = await stepCost(watch.sessionId, watch.lastAssistant);
    const dejaPorte = store.steps
      .ofRun(run.runId)
      .filter((ligne) => ligne.step_id === key.stepId && ligne.tentative === key.tentative && ligne.tour < key.tour && ligne.session_id === watch.sessionId)
      .reduce((somme, ligne) => somme + ligne.cost, 0);
    const cost = Math.max(0, sessionUsd - dejaPorte);

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
    if (state === "terminee") {
      run.resultats.set(key.stepId, texte);
      // 5b : la version de CE tour est gardée à part (journal de relecture) ; la clé nue garde la dernière (livrable, relais).
      run.resultats.set(tourKey(key.stepId, key.tour), texte);
      enregistrerVerdictOuChoix(run, key, texte);
    }
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
        // <c5:depot-fige>
        // GF4 (A28 C6) : ce que le cockpit a écrit dans ce message est figé ici, avec lui.
        audit(run.runId, "livraison", { etape: livrable.etapeSource, messageId, ...ecritAuDepot("resultat", livrable) });
        // </c5:depot-fige>
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

  /**
   * Votre réponse à une pause de choix (5b, spéc. l.772). Rien ne part avant elle, et rien ne part non plus quand elle ne tient
   * pas : les identifiants doivent être ceux de la liste, sans doublon, `choixMax` au plus. Un refus est rendu AVANT toute
   * écriture et toute requête — « Rien n'a été envoyé ni facturé ».
   * Le refus sort en 409 `choix-invalide` : le code a été ajouté à `TeamErrorCode` et à `team-texts.ts` par l'intégrateur du
   * train de la vague 2, sur la demande de contrat de ce paquet (plan it5 §2.4).
   */
  const repondreAuChoix = (run: RunMemory, body: TeamContinueBody): RunnerRefusal | null => {
    const bloc = blocEnChoix(run);
    if (!bloc) return refusal(409, "etat-incompatible");
    const specialistes = Array.isArray(bloc.specialistes) ? bloc.specialistes : [];
    if (body.aucun === true) {
      // « Aucun ne convient » : aucun spécialiste n'est lancé, donc rien n'est facturé (D-5-13).
      run.choix.set(bloc.id, "aucun");
      store.steps.patch(keyOf(run, bloc.aiguilleur.id), { choix: "aucun" });
      ecarterNonChoisis(run, bloc, []);
      audit(run.runId, "choix", { bloc: bloc.id, retenus: "aucun" }, "vous");
      return null;
    }
    const demandes = Array.isArray(body.choix) ? body.choix : null;
    const connus = new Set(specialistes.map((step) => step.id));
    const sansDouble = demandes === null ? [] : [...new Set(demandes)];
    if (
      demandes === null ||
      demandes.length === 0 ||
      sansDouble.length !== demandes.length ||
      demandes.length > choixMaxDe(bloc) ||
      demandes.some((id) => !connus.has(id))
    ) {
      return refusal(409, "choix-invalide");
    }
    // Ordre du déroulé, jamais celui du corps reçu : la liste rendue est celle que la carte et le Déroulé affichent.
    const retenus = specialistes.filter((step) => demandes.includes(step.id)).map((step) => step.id);
    run.choix.set(bloc.id, retenus);
    store.steps.patch(keyOf(run, bloc.aiguilleur.id), { choix: JSON.stringify(retenus) });
    ecarterNonChoisis(run, bloc, retenus);
    audit(run.runId, "choix", { bloc: bloc.id, retenus: retenus.join(",") }, "vous");
    return null;
  };

  /**
   * Spécialistes écartés par votre choix, et la synthèse quand elle ne travaille pas (moins de deux résultats choisis) :
   * état FINAL « non-choisi », sans coût. Ils n'ont jamais rien envoyé, donc rien n'est facturé pour eux.
   */
  const ecarterNonChoisis = (run: RunMemory, bloc: Extract<FlowBlock, { type: "aiguillage" }>, retenus: readonly string[]): void => {
    const specialistes = Array.isArray(bloc.specialistes) ? bloc.specialistes : [];
    const ecartes = specialistes.filter((step) => !retenus.includes(step.id)).map((step) => step.id);
    if (bloc.synthese && retenus.length < 2) ecartes.push(bloc.synthese.id);
    for (const stepId of ecartes) {
      const key = keyOf(run, stepId);
      if (store.steps.setState(key, "non-choisi", { cause: "vous" })) emitStep(run, key, "non-choisi", null);
    }
  };

  const continueRun = async (runId: string, body: TeamContinueBody, confirmed: boolean): Promise<TeamRunView | RunnerRefusal> => {
    const row = store.runs.get(runId);
    if (!row) return refusal(404, "not-found");
    if (!row.state.startsWith("attente-")) return refusal(409, "etat-incompatible");
    const precision = typeof body.precision === "string" ? body.precision : null;
    const correction = typeof body.correction === "string" ? body.correction : null;
    if ((precision !== null && precision.length > FLOW_LIMITS.precision) || (correction !== null && correction.length > FLOW_LIMITS.relaisCaracteres)) {
      return refusal(409, "invalid");
    }
    // 5b : `choix` et `aucun` ne valent QUE pour une pause de choix, et une pause de choix n'a pas d'autre sortie.
    const repondAuChoix = Array.isArray(body.choix) || body.aucun === true;
    if (repondAuChoix !== (row.state === "attente-choix")) return refusal(409, "etat-incompatible");
    if (row.state === "attente-budget" && !confirmed) return refusal(409, "budget-guard");
    const run = runs.get(runId) ?? reattach(runId);
    if (!run) return refusal(404, "not-found");
    // Instantané perdu (redémarrage du cockpit) : aucune étape ne peut repartir sans lui, et rien n'est envoyé ni facturé en
    // attendant. Aucune étape n'échoue faute d'instantané.
    // <c5:reprise-redemarrage>
    // Clôture 5b (D-5b-1). Ce contrôle passait AVANT votre réponse et refusait tout, « aucun » compris, en 409
    // `estimation-perimee` — dont la phrase (« une nouvelle estimation est affichée ») était fausse ici : rien n'était affiché,
    // et aucune route ne sortait de la pause. Désormais la réponse est jouée à blanc (`lanceraitUnAppel`) :
    // - une réponse qui ne lance rien passe sans instantané — « Aucun ne convient » sans bloc suivant, une pause suivie d'une autre
    //   pause, ou la fin de l'équipe ;
    // - toute réponse qui lancerait un appel facturé est refusée par `reestimation-requise`, AVANT toute écriture et toute
    //   requête ; sa phrase dit la vérité et la suite : refaire l'estimation (POST …/estimate), puis la confirmer
    //   (POST …/relancer). La pause revient alors, et c'est encore VOTRE réponse qui la fait repartir (spéc. l.772), avec toutes
    //   les gardes de facturation d'une étape — sauf la pause « Le cockpit a redémarré », dont la seule réponse est de continuer.
    if (run.plan === null && lanceraitUnAppel(run, row.state, row.cause, { aucun: body.aucun === true })) return refusal(409, "reestimation-requise");
    // </c5:reprise-redemarrage>
    if (row.state === "attente-choix") {
      const refus = repondreAuChoix(run, body);
      if (refus !== null) return refus;
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
      // 5b : la pause d'avant la première relecture porte l'identifiant de son bloc « relecture », qui n'est pas un bloc
      // « pause » — elle est donc notée à part, sinon l'ordonnanceur la redemanderait à chaque tour.
      const bloc = run.flow.blocs.find((entree) => entree.id === run.pauseBloc);
      if (bloc?.type === "relecture") run.pausesRelecture.push(run.pauseBloc);
      else run.pausesFranchies.push(run.pauseBloc);
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
    for (const row of lastRows(run.runId).values()) {
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
      // <c5:depot-fige>
      // GF4 (A28 C6) : ce que le cockpit a écrit dans ce message est figé ici, avec lui.
      audit(runId, "resultats-ajoutes", { messageId, ...ecritAuDepot(complet ? "resultat" : "resultats-partiels", complet) }, "vous");
      // </c5:depot-fige>
      return { messageId };
    } catch (err) {
      warn("résultats non ajoutés à la conversation", { runId, error: errorMessage(err) });
      return refusal(409, "etat-incompatible");
    }
  };

  // --- Relance ----------------------------------------------------------------------------------------------------------------

  /**
   * Bloc « relecture » qui REPART à la relance : une de ses deux étapes n'est pas terminée et son dernier verdict ne l'a pas
   * clos. Les deux lectures de l'état d'un bloc — les tours faits (`toursTermines`) et les verdicts rendus (`verdictsDesBlocs`)
   * — doivent alors porter sur la MÊME tentative : la ligne neuve du relecteur périme son verdict, comme celle du rédacteur
   * périme ses tours.
   */
  const relectureQuiRepart = (
    run: RunMemory,
    stepId: string,
    rows: Map<string, StepRow>,
    verdicts: Record<string, (VerdictRelecteur | null)[]>,
  ): boolean => {
    const bloc = etapeDuDeroule(run.flow, stepId)?.bloc;
    if (!bloc || bloc.type !== "relecture") return false;
    if ((verdicts[bloc.id] ?? []).at(-1) === "rien-a-reprendre") return false;
    return [bloc.auteur.id, bloc.relecteur.id].some((id) => rows.get(id)?.state !== "terminee");
  };

  /**
   * Bloc « aiguillage » dont VOTRE choix tient encore : son aiguilleur est terminé — sa ligne n'est donc pas recréée et garde
   * la colonne `choix` — et ce choix est lisible. Si l'aiguilleur lui-même repart, le choix est perdu avec sa ligne et les
   * spécialistes écartés doivent bien redevenir « prevue ».
   */
  const aiguillageArbitre = (
    run: RunMemory,
    stepId: string,
    rows: Map<string, StepRow>,
    confirmes: Record<string, string[] | "aucun">,
  ): boolean => {
    const bloc = etapeDuDeroule(run.flow, stepId)?.bloc;
    if (!bloc || bloc.type !== "aiguillage") return false;
    return rows.get(bloc.aiguilleur.id)?.state === "terminee" && Object.hasOwn(confirmes, bloc.id);
  };

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
    // <c5:reprise-redemarrage>
    // Clôture 5b (D-5b-1) : une PAUSE ne repart jamais par une relance complète. Sans instantané (redémarrage du cockpit), la
    // confirmation de la nouvelle estimation le lui rend (`reprendreApresRedemarrage`) ; avec son instantané, elle attend VOTRE
    // réponse par POST …/continue — une seconde confirmation arrivée juste après la première est donc refusée ici, sans rien lire
    // ni écrire.
    if (row.state.startsWith("attente-")) {
      if (run.plan !== null) return refusal(409, "pas-relancable");
      return reprendreApresRedemarrage(run, row.state, row.cause, plan, request);
    }
    // </c5:reprise-redemarrage>
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
    // 5b : une relance repart du TOUR 1, avec de nouvelles sessions et une tentative de plus (D-5-14). Les tours de la tentative
    // précédente restent en base comme historique, et `toursTermines` ne les compte plus.
    run.tours.clear();
    run.pausesRelecture = [];
    run.proposes.clear();
    run.raisons.clear();
    run.choix.clear();
    store.runs.patch(runId, { estimateSha256: plan.estimateSha256, plafond: plan.plafond, endedAt: null });
    // Nouvelle tentative (nouvelle ligne, nouvelle session) pour chaque étape non terminée ; les terminées ne sont pas refacturées.
    const rows = lastRows(runId);
    // État du déroulé AVANT les lignes neuves : les verdicts déjà rendus (pour savoir quel bloc de relecture repart) et VOTRE
    // choix, relu en base puisque `run.choix` vient d'être vidé (colonne `choix` de l'aiguilleur, ligne non recréée).
    const verdictsAvant = verdictsDesBlocs(run);
    const choixTenus = choixConfirmes(run);
    const tentativesMax = new Map<string, number>();
    for (const ligne of store.steps.ofRun(runId)) tentativesMax.set(ligne.step_id, Math.max(tentativesMax.get(ligne.step_id) ?? 0, ligne.tentative));
    for (const declaree of etapesDeclarees(run.flow)) {
      const previous = rows.get(declaree.stepId);
      // Une étape TERMINÉE n'est refaite que lorsque son bloc de relecture repart : le bloc entier recommence alors au tour 1,
      // avec de nouvelles sessions des deux côtés (D-5-14, fiche L42b). Sans cela, le rédacteur repartait seul au tour 1 tandis
      // que le verdict du relecteur, resté sur l'ancienne tentative, faisait redemander un tour 2 dont la session n'existait
      // plus : la relance retombait en échec sans rien envoyer, indéfiniment.
      if (previous?.state === "terminee" && !relectureQuiRepart(run, declaree.stepId, rows, verdictsAvant)) continue;
      // Un spécialiste écarté par VOTRE choix reste « Non choisi », état final, tant que ce choix tient en base. Le recréer
      // « prevue » le laissait ainsi pour toujours : `blocEnChoix` ne redemande rien et l'aiguillage ne lance que les retenus.
      if (previous?.state === "non-choisi" && aiguillageArbitre(run, declaree.stepId, rows, choixTenus)) continue;
      // La tentative la plus haute TOUS TOURS confondus : au tour 2 d'une relecture interrompue, la ligne du tour 1 porte déjà
      // la même tentative, et la nouvelle ligne du tour 1 doit lui succéder.
      const tentative = (tentativesMax.get(declaree.stepId) ?? 0) + 1;
      run.tentatives.set(declaree.stepId, tentative);
      const step = plan.etapes.find((entry) => entry.stepId === declaree.stepId);
      const declaration = etapeDuDeroule(run.flow, declaree.stepId);
      store.steps.create({
        runId,
        stepId: declaree.stepId,
        tour: 1,
        tentative,
        ordre: declaree.ordre,
        blocIndex: declaree.blocIndex,
        titre: step?.titre ?? previous?.titre ?? declaration?.step.titre ?? declaree.stepId,
        agent: step?.assistant ?? previous?.agent ?? declaration?.step.assistant ?? "",
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

  // <c5:reprise-redemarrage>
  /**
   * Clôture 5b (D-5b-1) : POST …/relancer sur une pause qui a survécu à un redémarrage du cockpit. La route n'arrive ici qu'après
   * l'estimation MONTRÉE (POST …/estimate), votre confirmation (x-cockpit-confirm: 1) et le pré-lancement complet de la relance
   * (A4 : budget, garde-fou P6, plafond, grammaire, configuration), qui rend l'instantané `plan`.
   * Ce n'est PAS une relance à tentative neuve : rien de déjà payé n'est refait — ni l'aiguilleur et sa proposition, ni le
   * premier jet d'une relecture — et aucune ligne n'est recréée. Le lancement retrouve seulement son instantané, et son plafond
   * celui de la nouvelle estimation (déjà dépensé compris). Ensuite :
   * - pause « Le cockpit a redémarré » : elle n'a pas d'autre réponse que « continuer », que votre confirmation donne. La suite
   *   repart par la préparation, donc par le contrôle de fraîcheur, comme une relance ;
   * - toute autre pause reste telle quelle (choix d'aiguillage, pause pour vérifier, budget, assistant changé, fraîcheur) : c'est
   *   VOTRE réponse qui la fera repartir, par POST …/continue, avec les gardes de chaque étape (recheckStep, billRefusal, plafond
   *   avec coût inconnu = refus, beginBilled). Le choix d'un aiguillage n'est jamais tranché ici (spéc. l.772).
   */
  const reprendreApresRedemarrage = async (
    run: RunMemory,
    state: TeamRunState,
    cause: TeamRunCause | null,
    plan: RunPlan,
    request: { demande: string; fichiers: string[] },
  ): Promise<TeamRunView | RunnerRefusal> => {
    // Transition d'abord, comme la relance : refusée, rien n'est touché ni en mémoire ni en base.
    const continuer = state === "attente-verification" && cause === "redemarrage-cockpit";
    if (continuer && !store.runs.setState(run.runId, "preparation")) return refusal(409, "pas-relancable");
    run.demande = request.demande;
    run.fichiers = request.fichiers;
    run.plan = plan;
    run.stopping = false;
    run.billRetries.clear();
    store.runs.patch(run.runId, { estimateSha256: plan.estimateSha256, plafond: plan.plafond });
    audit(run.runId, "reestimation", { estimation: plan.estimateSha256, depuis: state }, "vous");
    if (continuer) {
      runs.set(run.runId, run);
      emitRun(run);
      void schedule(run, () => startRun(run, { injecter: false }));
      return view(run.runId) ?? refusal(404, "not-found");
    }
    // Pause de fraîcheur (A4) : [Continuer] refera le contrôle, comme avant le redémarrage.
    if (state === "attente-verification" && cause === "changement") run.attenteFraicheur = true;
    runs.set(run.runId, run);
    emitRun(run);
    return view(run.runId) ?? refusal(404, "not-found");
  };
  // </c5:reprise-redemarrage>

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
    // Pauses déjà franchies (blocs « pause », pause d'avant la première relecture) : relues par `memoryFromRow`
    // (`restaurerApresRedemarrage`, clôture 5b), pour que la vue d'un lancement non suivi les connaisse aussi.
    const rows = lastRows(runId);
    for (const [stepId, row] of rows) {
      run.tentatives.set(stepId, row.tentative);
      // Tour COURANT de l'étape : celui de sa dernière ligne (une relecture en a une par tour).
      run.tours.set(stepId, row.tour);
    }
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
      const steps = lastRows(id);
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
      for (const [stepId, row] of lastRows(run.runId)) {
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
    for (const [stepId, row] of lastRows(runId)) {
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
