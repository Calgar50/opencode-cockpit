// Propriétaire : L11b.
// IA de contrôle (spécification §4.6, §3.12, §6 l.1041-1042, D8, P1, P5 ; plan d'exécution, fiche L11b) : port controlAi.judge.
// Elle ne juge qu'une commande « à juger » (S7 de la porte shell), en « Autonome avec contrôle », avec le réglage controleIa ; elle
// répond « autoriser » ou « attendre », jamais « refuser ». Tout ce qui n'est pas prouvé passe en attente de votre accord.
//   1. Domaine, sans réseau : réglage controleIa et interrupteur COCKPIT_AUTONOMY ; racine suivie de l'instance principale ; choix
//      « autonome » ; demande autonome en cours (ports.requests) ; commande « à juger » même dans le contexte le plus favorable
//      (S1-S4, U01 et les contrôles lexicaux de S5 ne dépendent pas du disque : une commande interdite ne crée aucune session) ;
//      entrée bornée (controlPrompt, L11a). Sinon « indisponible » (aucun appel, aucune session, rien de compté).
//   2. IA Rapide : TierService.resolve("rapide"), IA trouvée au catalogue du compte (statut « ok » ou « secours », fournisseur
//      autorisé, présente dans catalog.lite() : P1). « non-verifie » ou « indisponible » : aucun appel.
//   3. Agent cockpit-controle vu par opencode dans le dossier de la conversation (GET /agent) : primaire, consignes identiques au
//      fichier installé. Mesure L11b : avec COCKPIT_PROJECT_CONFIG=1, un agent de projet du même nom le remplace dans ce dossier
//      (.opencode/agent[s]/cockpit-controle.md) ; ses consignes différentes sont refusées ici, sans appel.
//   4. Sans aucune attente, jusqu'à la réservation : choix et demande relus (un resserrement pendant la lecture des agents annule),
//      plafond controlesIaMax (appels comptés par la demande, ou réservés ici : appels simultanés compris), canBill (application
//      de la configuration, redémarrage, adresse Copilot à revérifier), guardRuns (P5, jamais confirmé par l'autonomie), puis
//      réservation du contrôle et beginBilled (compté en vol jusqu'à la fin du nettoyage : une application de la configuration le
//      voit comme une réponse en cours).
//   5. Session CONTROLE vérifiée : createWithFloor (plancher « * * deny », écho vérifié, sinon supprimée), parentID = racine,
//      metadata.cockpit = « controle » et metadata.demande = la demande ; usage « controle » forcé. Choix et demande relus ensuite.
//   6. Message à cockpit-controle, délai de 30 s ; usage « controle » enregistré ; parseControlOutput (L11a).
//   7. Fin : appel terminé et session au repos (GET /session/status) → DELETE. Appel non terminé (délai, erreur), ou session encore
//      occupée ou d'état illisible après la réponse : POST /session/:id/abort, repos attendu sur /session/status (500 ms, 10 s au
//      plus, un second arrêt), coût du tour relevé, puis DELETE : DELETE seul n'arrête pas un tour en cours, qui continuerait
//      facturé (session.ts:606-627). Aucune réponse d'autorisation n'est jamais envoyée (ni « once » ni refus) : le plancher
//      CONTROLE retire tout outil.
// Aucune mémoire : une session neuve par contrôle, supprimée ensuite ; seul le nombre d'appels d'une demande est retenu (plafond).
// judge ne lève jamais : une erreur imprévue rend « indisponible » avant l'appel, « attendre » après (la commande attend).
// Les ports rendent des CODES : `raison` d'un verdict « attendre » est soit le texte de l'IA (masqué, 200 caractères au plus, à
// échapper à l'affichage), soit un code de CONTROL_PROBLEMS (réponse illisible, délai, erreur) ; isControlProblem les distingue.
// Recettes facturées EN ATTENTE (décision de l'utilisateur : aucune exécution Copilot réelle dans les itérations 1 et 2) : M7 (la
// dernière ligne DÉCISION est-elle respectée par l'IA Rapide réelle ?), M8 et la barrière des 60 commandes (30 inoffensives, 30
// nuisibles hors S4 : une seule autorisation nuisible → livré avec controleIa: false). Testé ici hors ligne, sur le faux opencode.
// neutralControlAi reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import path from "node:path";
import { canBill } from "./config-queue.ts";
import type { Cockpit11, Cockpit11Module, ControlAiInput, ControlAiPort, ControlAiUnavailableCode, ControlAiVerdict } from "./contracts-11.ts";
import { errorMessage } from "./log.ts";
import type { OcAssistantMessage, OcPart, OcSession } from "./opencode.ts";
import type { SessionRow } from "./sessions.ts";
import type { Run } from "./shared/assistant-rules.ts";
import { modelName, providerOf } from "./shared/assistant-rules.ts";
import type { AutonomyRequestView } from "./shared/autonomy-types.ts";
import { CONTROL_AGENT_FILE, CONTROL_AGENT_NAME, type ControlOutputProblem, controlPrompt, parseControlOutput } from "./shared/control-ai-output.ts";
import { ID_RE } from "./shared/ids.ts";
import { classifyCommand, type ShellContext } from "./shared/shell-gate.ts";

export function neutralControlAi(): ControlAiPort {
  return {
    judge: async () => ({ decision: "indisponible", raison: "a-venir" }),
  };
}

/** Délai du message à l'IA de contrôle (§4.6, §3.10). */
export const CONTROL_MESSAGE_TIMEOUT_MS = 30_000;
/** Titre de la session de contrôle (§4.6) : ligne « Contrôle de sécurité » de « Qui travaille ? ». */
export const CONTROL_SESSION_TITLE = "Contrôle de sécurité";
/** Repos après un arrêt : sondé toutes les 500 ms pendant 10 s au plus, comme l'arrêt de l'arbre (§3.12). */
export const CONTROL_IDLE_PROBE_MS = 500;
export const CONTROL_IDLE_WINDOW_MS = 10_000;
/** Délai de chaque requête du nettoyage (arrêt, état, messages, suppression). */
export const CONTROL_CLEANUP_TIMEOUT_MS = 10_000;
/** Demandes dont le nombre de contrôles réservés est retenu (les plus anciennes sont oubliées au-delà). */
export const CONTROL_RESERVATIONS_MAX = 256;

/**
 * Codes d'un verdict « attendre » sans texte de l'IA : réponse illisible (L11a), délai dépassé, appel ou réponse en erreur,
 * session de contrôle non vérifiée. La commande attend votre accord.
 */
export type ControlCallProblem = ControlOutputProblem | "delai-depasse" | "appel-en-erreur" | "reponse-en-erreur" | "session-non-verifiee";

export const CONTROL_PROBLEMS: ReadonlySet<string> = new Set<ControlCallProblem>([
  "reponse-vide",
  "decision-absente",
  "decision-multiple",
  "decision-non-finale",
  "decision-invalide",
  "raison-absente",
  "raison-multiple",
  "raison-vide",
  "raison-trop-longue",
  "delai-depasse",
  "appel-en-erreur",
  "reponse-en-erreur",
  "session-non-verifiee",
]);

/** Verdict « attendre » rendu par le cockpit (code), et non par l'IA (texte). */
export function isControlProblem(verdict: ControlAiVerdict): boolean {
  return verdict.decision === "attendre" && CONTROL_PROBLEMS.has(verdict.raison);
}

/** Consignes de l'agent telles qu'opencode les rend dans GET /agent (corps du fichier, sans l'en-tête, espaces de bord retirés). */
export const CONTROL_AGENT_PROMPT = CONTROL_AGENT_FILE.replace(/^---\n[\s\S]*?\n---\n/, "").trim();

/** Cause d'une IA de contrôle non consultée (journal seulement ; le port rend le code du contrat). */
type Skip =
  | "entree-invalide"
  | "reglage"
  | "interrupteur"
  | "racine"
  | "hors-autonome"
  | "demande"
  | "hors-domaine"
  | "entree-hors-bornes"
  | "plafond"
  | "ia-rapide"
  | "agent"
  | "choix-resserre"
  | "facturation"
  | "budget";

const SKIP_CODE: Readonly<Record<Skip, ControlAiUnavailableCode>> = {
  "entree-invalide": "desactive",
  reglage: "desactive",
  interrupteur: "desactive",
  racine: "desactive",
  "hors-autonome": "desactive",
  demande: "desactive",
  "hors-domaine": "desactive",
  "entree-hors-bornes": "desactive",
  plafond: "plafond-controles",
  "ia-rapide": "ia-rapide-absente",
  agent: "agent-non-installe",
  "choix-resserre": "desactive",
  facturation: "facturation-suspendue",
  budget: "budget-refuse",
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const enc = encodeURIComponent;

/**
 * Verdict de la porte shell dans le contexte le plus favorable : dossier de travail = dossier de la conversation, chaque chemin
 * cité résolu lexicalement sans lien et existant, recherche récursive sans chemin sensible, `.git` sain (configuration, hooks,
 * sous-modules, index sans chemin suivi sensible). Les faits réels ne peuvent que
 * resserrer (attente) : une commande qui n'est pas « à juger » ici ne l'est jamais. L'appelant (L10a) a déjà classé la commande
 * avec les faits du disque (L8b) ; cette seconde lecture empêche seulement tout appel pour S1-S4, U01 et les chemins lexicaux.
 */
export function favorableShellVerdict(command: string, conversationDir: string): ReturnType<typeof classifyCommand> {
  const ctx: ShellContext = {
    conversationDir,
    workdir: null,
    paths: {
      resolve: (arg) => ({ inside: true, symlinkOut: false, real: path.posix.resolve(conversationDir, arg) }),
      sensitiveEntries: () => [],
      exists: () => true,
    },
    git: { gitIsDirectory: true, configText: "", launcher: null, trackedSensitive: [] },
    allowJudge: true,
  };
  return classifyCommand(command, ctx);
}

export interface ControlAiOptions {
  /** Absent : CONTROL_MESSAGE_TIMEOUT_MS (30 s). */
  messageTimeoutMs?: number;
  idleProbeMs?: number;
  idleWindowMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

type Unavailable = Extract<ControlAiVerdict, { decision: "indisponible" }>;

/** Verdict lu après un message : texte de l'IA (masqué) ou code de CONTROL_PROBLEMS. */
interface Answer {
  decision: "autoriser" | "attendre";
  raison: string;
}

/** Commande admise à l'étape 1 : entrée (demande identifiée), dossier de la conversation, message à l'IA. */
interface Admitted {
  input: ControlAiInput & { requestId: string };
  directory: string;
  prompt: string;
}

export function createControlAi(c11: Cockpit11, options: ControlAiOptions = {}): ControlAiPort {
  const { log } = c11;
  const messageTimeoutMs = options.messageTimeoutMs ?? CONTROL_MESSAGE_TIMEOUT_MS;
  const idleProbeMs = options.idleProbeMs ?? CONTROL_IDLE_PROBE_MS;
  const idleWindowMs = options.idleWindowMs ?? CONTROL_IDLE_WINDOW_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  /** Contrôles réservés par demande : un appel compte dès que sa session est demandée (plafond tenu même entre appels simultanés). */
  const reserved = new Map<string, number>();

  const skip = (input: Pick<ControlAiInput, "rootId">, cause: Skip, fields: Record<string, unknown> = {}): Unavailable => {
    log.info("IA de contrôle non consultée : la commande attend votre accord", { rootId: String(input.rootId).slice(0, 128), cause, ...fields });
    return { decision: "indisponible", raison: SKIP_CODE[cause] };
  };

  const settingsAllow = (): boolean => c11.env.autonomy && c11.settings.get().budget.autonomie.controleIa === true;

  /** Demande autonome en cours de la racine, la même que celle du contrôle ; null sinon. */
  const currentRequest = (rootId: string, requestId: string): AutonomyRequestView | null => {
    const request = c11.ports.requests.current(rootId);
    if (!request || request.id !== requestId || request.rootId !== rootId || request.fin !== null || request.choix !== "autonome") return null;
    return request;
  };

  /**
   * Choix, réglages et demande toujours valables (relus après chaque attente : un resserrement annule le contrôle). Un port qui
   * lève vaut « resserré » : la session déjà créée est supprimée, rien n'est envoyé.
   */
  const stillAllowed = (rootId: string, requestId: string): boolean => {
    try {
      return settingsAllow() && c11.ports.conversationAutonomy.choiceOf(rootId) === "autonome" && currentRequest(rootId, requestId) !== null;
    } catch (err) {
      log.warn("IA de contrôle : choix ou demande illisibles, contrôle annulé", { rootId, error: errorMessage(err) });
      return false;
    }
  };

  const used = (request: AutonomyRequestView): number => Math.max(request.controles, reserved.get(request.id) ?? 0);

  /** Un contrôle de plus pour la demande ; la demande passe en fin de liste (la plus ancienne est oubliée la première). */
  const reserve = (requestId: string): void => {
    const count = (reserved.get(requestId) ?? 0) + 1;
    reserved.delete(requestId);
    reserved.set(requestId, count);
    while (reserved.size > CONTROL_RESERVATIONS_MAX) {
      const oldest = reserved.keys().next().value;
      if (oldest === undefined) break;
      reserved.delete(oldest);
    }
  };

  const release = (requestId: string): void => {
    const count = reserved.get(requestId) ?? 0;
    if (count <= 1) reserved.delete(requestId);
    else reserved.set(requestId, count - 1);
  };

  /** IA Rapide trouvée au catalogue du compte, d'un fournisseur autorisé (P1) ; null sinon. */
  const rapidModel = (): string | null => {
    const resolution = c11.tiers.resolve("rapide");
    const model = resolution.model;
    if ((resolution.status !== "ok" && resolution.status !== "secours") || !model) return null;
    if (!c11.env.allowedProviders.includes(providerOf(model))) return null;
    return c11.catalog.lite().some((entry) => entry.key === model) ? model : null;
  };

  /** Agent cockpit-controle vu par opencode dans ce dossier : primaire, consignes du fichier installé (et non d'un agent de projet). */
  const agentReady = async (directory: string): Promise<boolean> => {
    try {
      const snapshot = await c11.lookup.get(directory);
      const agent = snapshot.agents.find((candidate) => candidate.name === CONTROL_AGENT_NAME);
      return agent !== undefined && agent.mode === "primary" && typeof agent.prompt === "string" && agent.prompt.trim() === CONTROL_AGENT_PROMPT;
    } catch (err) {
      log.warn("IA de contrôle : agents d'opencode illisibles", { error: errorMessage(err) });
      return false;
    }
  };

  /** Sessions occupées d'un dossier, ou null si l'état est illisible. */
  const busy = async (sessionId: string, directory: string): Promise<boolean | null> => {
    try {
      const status = await c11.client.request<unknown>("GET", "/session/status", { directory, timeoutMs: CONTROL_CLEANUP_TIMEOUT_MS });
      if (!isRecord(status)) return null;
      const entry = status[sessionId];
      return entry !== undefined && !(isRecord(entry) && entry.type === "idle");
    } catch {
      return null;
    }
  };

  const abort = async (sessionId: string, directory: string): Promise<void> => {
    try {
      await c11.client.request("POST", `/session/${enc(sessionId)}/abort`, { directory, timeoutMs: CONTROL_CLEANUP_TIMEOUT_MS });
    } catch (err) {
      log.warn("IA de contrôle : arrêt de la session refusé", { sessionId, error: errorMessage(err) });
    }
  };

  /** Repos confirmé après l'arrêt : sonde toutes les 500 ms pendant 10 s au plus, un second arrêt, dernière sonde. */
  const waitIdle = async (sessionId: string, directory: string): Promise<boolean> => {
    const start = now();
    let state = await busy(sessionId, directory);
    while (state !== false && now() - start < idleWindowMs) {
      await sleep(idleProbeMs);
      state = await busy(sessionId, directory);
    }
    if (state === false) return true;
    await abort(sessionId, directory);
    await sleep(idleProbeMs);
    return (await busy(sessionId, directory)) === false;
  };

  /** Coût du tour interrompu relevé avant la suppression (le flux d'événements l'enregistre aussi : même clé message_id). */
  const recordTurn = async (session: OcSession, row: SessionRow): Promise<void> => {
    try {
      const messages = await c11.client.request<unknown>("GET", `/session/${enc(session.id)}/message`, { directory: session.directory, timeoutMs: CONTROL_CLEANUP_TIMEOUT_MS });
      if (!Array.isArray(messages)) return;
      for (const message of messages.slice(0, 20)) {
        const info = isRecord(message) ? message.info : null;
        if (isRecord(info) && info.role === "assistant" && info.sessionID === session.id) c11.ledger.recordAssistant(info as unknown as OcAssistantMessage, row);
      }
    } catch (err) {
      log.warn("IA de contrôle : coût du tour interrompu non relevé", { sessionId: session.id, error: errorMessage(err) });
    }
  };

  /**
   * Fin de l'appel, puis suppression de la session (jamais avant le repos). « non-envoye » : aucun message, suppression seule.
   * « termine » : réponse reçue ; si la session est encore occupée (ou son état illisible), elle est arrêtée comme un appel non
   * terminé. « non-termine » (délai, erreur) : arrêt, repos attendu, coût du tour relevé. Rend true si la session a été arrêtée.
   */
  const cleanup = async (session: OcSession, row: SessionRow | null, end: "non-envoye" | "termine" | "non-termine"): Promise<boolean> => {
    const directory = session.directory;
    const stop = end === "non-termine" || (end === "termine" && (await busy(session.id, directory)) !== false);
    if (stop) {
      if (end === "termine") log.warn("IA de contrôle : session encore occupée après la réponse, arrêtée", { sessionId: session.id });
      await abort(session.id, directory);
      if (!(await waitIdle(session.id, directory))) log.warn("IA de contrôle : arrêt non confirmé, session supprimée quand même", { sessionId: session.id });
      if (row !== null) await recordTurn(session, row);
    }
    try {
      await c11.client.request("DELETE", `/session/${enc(session.id)}`, { directory, timeoutMs: CONTROL_CLEANUP_TIMEOUT_MS });
    } catch (err) {
      log.warn("IA de contrôle : session de contrôle non supprimée", { sessionId: session.id, error: errorMessage(err) });
    }
    return stop;
  };

  /** Coût enregistré des appels de la session de contrôle ; null si aucun appel n'est enregistré. */
  const costOf = (sessionId: string): number | null => {
    try {
      const row = c11.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(cost), 0) AS cost FROM usage WHERE session_id = ?").get(sessionId) as { n: number; cost: number };
      return row.n > 0 ? row.cost : null;
    } catch {
      return null;
    }
  };

  const textOf = (parts: unknown): string =>
    Array.isArray(parts)
      ? parts
          .filter((part): part is OcPart => isRecord(part) && part.type === "text")
          .map((part) => (typeof part.text === "string" ? part.text : ""))
          .join("\n")
      : "";

  /**
   * Session CONTROLE créée par le port des planchers (plancher vérifié sur l'écho, sinon supprimée par lui), puis vérifiée ici :
   * identifiant, parentID = racine, metadata.cockpit = « controle », metadata.demande, dossier. Non conforme : supprimée. null :
   * aucune session utilisable (aucun appel d'IA, donc aucun coût).
   */
  const openSession = async (rootId: string, requestId: string, directory: string): Promise<{ session: OcSession; row: SessionRow | null } | null> => {
    let session: OcSession;
    try {
      session = await c11.ports.floors.createWithFloor("CONTROLE", {
        directory,
        title: CONTROL_SESSION_TITLE,
        parentID: rootId,
        metadata: { cockpit: "controle", demande: requestId },
      });
    } catch (err) {
      // Écho qui ne tient pas le plancher : session déjà supprimée par le port ; autre erreur : rien de créé à notre connaissance.
      log.warn("IA de contrôle : session de contrôle non créée", { rootId, error: errorMessage(err) });
      return null;
    }
    const idOk = typeof session.id === "string" && ID_RE.test(session.id);
    const metadata = isRecord(session.metadata) ? session.metadata : {};
    const verified =
      idOk && session.parentID === rootId && metadata.cockpit === "controle" && metadata.demande === requestId && session.directory === directory;
    if (!verified) {
      log.warn("IA de contrôle : session de contrôle non conforme, supprimée", { rootId, sessionId: typeof session.id === "string" ? session.id.slice(0, 128) : null });
      if (idOk) await cleanup({ ...session, directory }, null, "non-envoye");
      return null;
    }
    try {
      return { session, row: c11.sessions.upsert(session, "controle") };
    } catch (err) {
      log.warn("IA de contrôle : session de contrôle non suivie", { sessionId: session.id, error: errorMessage(err) });
      return { session, row: null };
    }
  };

  /** Réponse reçue : coût enregistré (usage « controle »), puis verdict de l'IA ou code du défaut. */
  const readAnswer = (response: unknown, session: OcSession, row: SessionRow | null): Answer => {
    const info = isRecord(response) ? response.info : null;
    if (!isRecord(info) || info.role !== "assistant" || info.sessionID !== session.id || typeof info.id !== "string") {
      return { decision: "attendre", raison: "appel-en-erreur" satisfies ControlCallProblem };
    }
    if (row !== null) {
      try {
        c11.ledger.recordAssistant(info as unknown as OcAssistantMessage, row);
      } catch (err) {
        log.warn("IA de contrôle : coût non enregistré", { sessionId: session.id, error: errorMessage(err) });
      }
    }
    if (info.error !== undefined && info.error !== null) return { decision: "attendre", raison: "reponse-en-erreur" satisfies ControlCallProblem };
    const parsed = parseControlOutput(textOf(isRecord(response) ? response.parts : null));
    return { decision: parsed.decision, raison: parsed.raison };
  };

  /** Message à cockpit-controle, délai `messageTimeoutMs` (30 s) ; `finished` : réponse reçue d'opencode. */
  const ask = async (session: OcSession, row: SessionRow | null, model: string, prompt: string): Promise<Answer & { finished: boolean; ms: number }> => {
    const slash = model.indexOf("/");
    const ref = { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
    const sentAt = now();
    try {
      const response = await c11.client.request<unknown>("POST", `/session/${enc(session.id)}/message`, {
        directory: session.directory,
        timeoutMs: messageTimeoutMs,
        body: { agent: CONTROL_AGENT_NAME, model: ref, parts: [{ type: "text", text: prompt }] },
      });
      return { finished: true, ms: now() - sentAt, ...readAnswer(response, session, row) };
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      const raison: ControlCallProblem = timedOut ? "delai-depasse" : "appel-en-erreur";
      log.warn("IA de contrôle : appel non terminé", { sessionId: session.id, cause: raison, error: errorMessage(err) });
      return { finished: false, ms: now() - sentAt, decision: "attendre", raison };
    }
  };

  /** Session vérifiée, message, lecture ; rend le verdict (le nettoyage est toujours fait avant). */
  const call = async (input: ControlAiInput & { requestId: string }, directory: string, model: string, prompt: string): Promise<ControlAiVerdict> => {
    const { rootId, requestId } = input;
    const opened = await openSession(rootId, requestId, directory);
    if (opened === null) return { decision: "attendre", raison: "session-non-verifiee" satisfies ControlCallProblem, model, costUsd: null, ms: 0 };
    const { session, row } = opened;
    // Resserrement pendant la création : aucun message, session supprimée, contrôle non compté.
    if (!stillAllowed(rootId, requestId)) {
      await cleanup(session, row, "non-envoye");
      release(requestId);
      return skip(input, "choix-resserre");
    }
    const answer = await ask(session, row, model, prompt);
    const stopped = await cleanup(session, row, answer.finished ? "termine" : "non-termine");
    // Réponse reçue alors que la session travaillait encore (ou état illisible) : réponse incohérente, jamais tenue pour sûre.
    const { decision, raison } = answer.finished && stopped ? { decision: "attendre" as const, raison: "reponse-en-erreur" satisfies ControlCallProblem } : answer;
    return { decision, raison, model, costUsd: costOf(session.id), ms: answer.ms };
  };

  /** Racine suivie, conversation de l'instance principale, dont `sessionId` fait partie ; son dossier, ou null. */
  const conversationDir = (rootId: string, sessionId: string): string | null => {
    const root = c11.sessions.get(rootId);
    if (!root || root.parent_id !== null || root.root_id !== rootId || root.purpose !== "chat" || root.instance !== "principale") return null;
    if (sessionId !== rootId && c11.sessions.rootOf(sessionId) !== rootId) return null;
    const directory = root.directory;
    return directory.startsWith("/") && c11.projects.isAllowedDirectory(directory) ? directory : null;
  };

  /** Étape 1, sans réseau : ce qui fait qu'une commande relève de l'IA de contrôle. */
  const admit = (input: ControlAiInput): Admitted | Unavailable => {
    if (!isRecord(input) || typeof input.rootId !== "string" || !ID_RE.test(input.rootId)) return skip({ rootId: "" }, "entree-invalide");
    const { rootId, sessionId, requestId, command, head, relativeDir } = input;
    const idsOk = typeof sessionId === "string" && ID_RE.test(sessionId) && typeof requestId === "string" && requestId.length > 0 && requestId.length <= 128;
    if (!idsOk || typeof command !== "string") return skip(input, "entree-invalide");
    if (!c11.env.autonomy) return skip(input, "interrupteur");
    if (!settingsAllow()) return skip(input, "reglage");
    const directory = conversationDir(rootId, sessionId);
    if (directory === null) return skip(input, "racine");
    if (c11.ports.conversationAutonomy.choiceOf(rootId) !== "autonome") return skip(input, "hors-autonome");
    const request = currentRequest(rootId, requestId);
    if (request === null) return skip(input, "demande");
    const gate = favorableShellVerdict(command, directory);
    if (gate.verdict !== "a-juger") return skip(input, "hors-domaine", { regle: gate.regle });
    const prompt = controlPrompt({ command, head, relativeDir });
    if (prompt === null) return skip(input, "entree-hors-bornes");
    return { input: { ...input, requestId }, directory, prompt };
  };

  /** Étape 4, sans attente : choix et demande relus, plafond, canBill, garde-fou (jamais confirmé : P5) ; null si l'appel peut partir. */
  const billable = (input: ControlAiInput & { requestId: string }, model: string): Unavailable | null => {
    const { rootId, requestId } = input;
    const request = stillAllowed(rootId, requestId) ? currentRequest(rootId, requestId) : null;
    if (request === null) return skip(input, "choix-resserre");
    if (used(request) >= request.plafonds.controlesIaMax) return skip(input, "plafond", { max: request.plafonds.controlesIaMax });
    if (!canBill({ queue: c11.configQueue, control: c11.control, copilotConfig: c11.copilotConfig })) return skip(input, "facturation");
    const run: Run = { role: "message", model, variant: null, source: "niveau", agent: CONTROL_AGENT_NAME };
    const lite = c11.catalog.lite();
    const refusal = c11.ledger.guardRuns([run], false, {
      command: null,
      modelName: (key) => modelName(key, lite),
      tierOfModel: (key) => c11.tiers.tierOfModel(key),
      size: "S",
    });
    return refusal === null ? null : skip(input, "budget", { code: refusal.code ?? null });
  };

  /** Étapes 1 à 3 : domaine, IA Rapide, agent ; rien n'est facturé ni compté. */
  const prepare = async (raw: ControlAiInput): Promise<(Admitted & { model: string }) | Unavailable> => {
    const admitted = admit(raw);
    if ("decision" in admitted) return admitted;
    const { input, directory } = admitted;
    // 2. IA Rapide (P1).
    const model = rapidModel();
    if (model === null) return skip(input, "ia-rapide");
    // 3. Agent vu par opencode dans le dossier de la conversation.
    if (!(await agentReady(directory))) return skip(input, "agent");
    return { ...admitted, model };
  };

  /** Erreur imprévue avant tout appel : la commande attend votre accord (le port ne lève jamais). */
  const failedBeforeCall = (err: unknown): Unavailable => {
    log.warn("IA de contrôle non consultée après une erreur : la commande attend votre accord", { error: errorMessage(err) });
    return { decision: "indisponible", raison: "desactive" };
  };

  const judge = async (raw: ControlAiInput): Promise<ControlAiVerdict> => {
    let ready: (Admitted & { model: string }) | Unavailable;
    let refused: Unavailable | null;
    try {
      ready = await prepare(raw);
      if ("decision" in ready) return ready;
      // 4. Relecture, plafond, canBill, garde-fou, puis réservation et compté en vol, sans attente entre eux.
      refused = billable(ready.input, ready.model);
    } catch (err) {
      return failedBeforeCall(err);
    }
    if (refused !== null) return refused;
    const { input, directory, prompt, model } = ready;
    reserve(input.requestId);
    const endBilled = c11.configQueue.beginBilled();
    try {
      const verdict = await call(input, directory, model, prompt);
      const consulted = verdict.decision !== "indisponible";
      log.info("IA de contrôle : fin du contrôle", {
        rootId: input.rootId,
        requestId: input.requestId,
        decision: verdict.decision,
        raison: consulted && !isControlProblem(verdict) ? "texte" : verdict.raison,
        model: consulted ? verdict.model : null,
        costUsd: consulted ? verdict.costUsd : null,
        ms: consulted ? verdict.ms : null,
      });
      return verdict;
    } catch (err) {
      // Filet : call() nettoie lui-même ; une erreur imprévue laisse la commande en attente, contrôle compté (prudent).
      log.warn("IA de contrôle : contrôle interrompu par une erreur, la commande attend votre accord", { rootId: input.rootId, error: errorMessage(err) });
      return { decision: "attendre", raison: "appel-en-erreur" satisfies ControlCallProblem, model, costUsd: null, ms: 0 };
    } finally {
      endBilled();
    }
  };

  return { judge };
}

/** Module avec des délais ou une horloge injectés (tests) ; production : controlAiModule. */
export function createControlAiModule(options: ControlAiOptions = {}): Cockpit11Module {
  return {
    name: "controlAi",
    install(_reg, c11) {
      c11.ports.controlAi = createControlAi(c11, options);
    },
  };
}

export const controlAiModule: Cockpit11Module = createControlAiModule();
