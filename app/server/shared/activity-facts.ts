// Faits d'activité (spécification §3.7, §3.10 point 6, §5.7.3, M15, JP-8 ; plan d'exécution, fiche L4a) : un événement opencode
// devient des faits `activity_facts` SANS texte de message ; « Revoir » relit ces faits par la même fonction que le direct (P12).
// Fournit : factsFromEvent(event, ctx), eventTime(id, receivedAt), la garde « aucun texte dans data » (factDataProblem,
// factProblem, assertFact), sessionRole (une session « controle » n'est jamais du travail délégué), les doublons du flux (factKey,
// FactDeduper, dedupeFacts), la fusion du direct et du différé par identité (mergeFacts) et EventMemory (rôles des messages vus
// dans le flux).
// Module pur (server/shared) : aucun module node, aucun accès à process (test de pureté de core.test.ts).
//
// Faits produits (`data` : codes, identifiants, nombres, clés ; jamais un titre, une consigne, une sortie, un motif ni un chemin) :
// - statut {etat: creee, role, parent, agent, instance}            session.created (enveloppe d'un enfant sans partie task)
// - statut {etat: occupee | repos | nouvelle-tentative, tentative?}  session.status (busy, idle, retry)
// - statut {etat: erreur, erreur}                                    session.error (nom de l'erreur, jamais son message)
// - statut {etat: memoire-resumee}                                   session.compacted
// - statut {etat: taches, faites, total}                             todo.updated (« 4/7 »)
// - statut {etat: appel | appel-fini, messageId, cout?, raison?}     parties step-start et step-finish (coût à l'arrivée)
// - statut {etat: redige, messageId}                                 partie texte d'un message de l'assistant
// - statut {etat: outil, outil, nom, phase: en-cours | termine | erreur | interrompu, callId, messageId, fichier, dossier}
//                                                                     parties d'outil autres que task (fichier, dossier : pathKey)
// - consigne {etat: prepare | envoyee, callId, messageId, enfant?, agent?, source?, commande?, reprise?}   partie task
// - resultat {etat: rendu | echec | interrompu, callId, messageId, enfant}                                partie task close
// - attente {permission, messageId, callId, agent} · reponse {reponse}                  permission.asked · permission.replied
// - origine {origine, cas, messageId, relance?}                      message utilisateur (§5.7.2) : dès sa première partie texte ou
//                                                                     subtask pour les cas 1 à 3 ; sinon quand toutes ses parties
//                                                                     sont connues (réponse de l'assistant, ou session au repos)
// - reveil {etat: depose, messageId}                                 message classé « reveil-sans-reponse » (cas 4, JP-2) : résultat
//                                                                     déposé, lu au prochain tour, sans appel d'IA et sans coût
// - reprise {callId, messageId, enfant, tache}                       partie task qui reprend une tâche existante (`task_id`,
//                                                                     `session_id`) : l'enfant n'est pas neuf (§5.8, légendes)
// - carnet {etat: lu | modifie, chemin, fichier, dossier, callId, messageId}   outil sur `.omo/notepads/**` ou `.omo/plans/**` dans
//                                                                     la salle (JP-6) : chemin RELATIF, jamais le contenu
// Les faits decision, choix, affichage et statut {cause} sont écrits par leurs services (L10, L6a, L4b, L1c) ; detection vient avec
// le service de la Salle OMO (L23).
import { redactSecrets } from "../redact.ts";
import type { ActivityFact, ActivityFactKind, FactValue, SessionInstance, SessionRole } from "./activity-types.ts";
import { ID_RE } from "./ids.ts";
import { contextVerdict, type OriginContext, type OriginPart, originPartSummary, type OriginVerdict, originVerdict, partsCarryHookPrefix } from "./message-origin.ts";

// --- Heure d'un événement (M15) -------------------------------------------------------------------------------------------------

/**
 * M15 : écart maximal accepté entre l'heure lue dans l'identifiant d'un événement et sa réception. Mesuré sur les 477 événements
 * des captures p1, p2, p6 et p7 : l'heure de l'identifiant précède toujours la réception, de 0 à 223 ms, et vaut la propriété
 * `time` des parties à 1 ms près. Au-delà, ou pour une heure postérieure à la réception, l'heure de réception fait foi.
 */
export const EVENT_TIME_MAX_LAG_MS = 223;

/** Identifiant croissant d'opencode : préfixe, 12 chiffres hexadécimaux (heure × 4096 + compteur, sur 48 bits), puis aléa. */
const ASCENDING_ID_RE = /^[a-z]{1,16}_([0-9a-f]{12})[0-9A-Za-z]{1,114}$/;
/** Les 48 bits gardent les 36 bits de poids faible de l'heure en millisecondes (environ 795 jours). */
const ID_TIME_SPAN = 2 ** 36;

/** Heure (ms) lue dans un identifiant croissant, rapportée à la période qui précède `receivedAt` ; null si illisible. */
export function idTime(id: unknown, receivedAt: number): number | null {
  if (typeof id !== "string" || !Number.isSafeInteger(receivedAt) || receivedAt < 0) return null;
  const match = ASCENDING_ID_RE.exec(id);
  if (!match?.[1]) return null;
  const low = Math.floor(Number.parseInt(match[1], 16) / 4096);
  const lag = (((receivedAt % ID_TIME_SPAN) - low) % ID_TIME_SPAN + ID_TIME_SPAN) % ID_TIME_SPAN;
  return receivedAt - lag;
}

/** Heure d'un événement : celle de son identifiant si elle précède la réception d'au plus EVENT_TIME_MAX_LAG_MS, sinon la réception. */
export function eventTime(id: unknown, receivedAt: number): number {
  const fromId = idTime(id, receivedAt);
  return fromId !== null && receivedAt - fromId <= EVENT_TIME_MAX_LAG_MS ? fromId : receivedAt;
}

// --- Garde « aucun texte de message dans data » ----------------------------------------------------------------------------------

const FACT_KINDS: Readonly<Record<ActivityFactKind, true>> = {
  statut: true,
  attente: true,
  reponse: true,
  origine: true,
  consigne: true,
  resultat: true,
  reveil: true,
  reprise: true,
  carnet: true,
  detection: true,
  affichage: true,
  decision: true,
  choix: true,
};

export const FACT_DATA_MAX_KEYS = 16;
const DATA_KEY_RE = /^[a-z][A-Za-z0-9]{0,31}$/;
/** Code, identifiant, nom technique ou clé : ni espace, ni ponctuation de phrase, 128 caractères au plus. */
const DATA_STRING_RE = /^[A-Za-z0-9_./-]{0,128}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function dataValueAllowed(value: unknown): value is FactValue {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && DATA_STRING_RE.test(value) && redactSecrets(value) === value;
}

/** Raison du refus du `data` d'un fait (texte, secret, type ou clé refusés), null s'il est permis. Aucun extrait n'est recopié. */
export function factDataProblem(data: unknown): string | null {
  if (!isRecord(data)) return "data doit être un objet";
  const entries = Object.entries(data);
  if (entries.length > FACT_DATA_MAX_KEYS) return "data : trop de champs";
  for (const [key, value] of entries) {
    if (!DATA_KEY_RE.test(key)) return "data : nom de champ refusé";
    if (!dataValueAllowed(value)) return `data.${key} : seuls un code, un identifiant, un nombre, un booléen ou null sont permis`;
  }
  return null;
}

/** Raison du refus d'un fait (identifiants, nature, heure, data), null s'il est permis. */
export function factProblem(fact: unknown): string | null {
  if (!isRecord(fact)) return "fait : objet attendu";
  if (idOf(fact.rootId) === null) return "rootId invalide";
  if (idOf(fact.sessionId) === null) return "sessionId invalide";
  if (typeof fact.kind !== "string" || !Object.hasOwn(FACT_KINDS, fact.kind)) return "kind inconnu";
  if (fact.ref !== null && idOf(fact.ref) === null) return "ref invalide";
  if (!Number.isSafeInteger(fact.at) || (fact.at as number) < 0) return "at invalide";
  return factDataProblem(fact.data);
}

/** Garde pour tout écrivain de faits (magasin, arrêt, choix, décisions) : lève RangeError si le fait est refusé. */
export function assertFact(fact: ActivityFact): ActivityFact {
  const problem = factProblem(fact);
  if (problem !== null) throw new RangeError(`fait d'activité refusé (${String(fact?.kind)}) : ${problem}`);
  return fact;
}

// --- Rôles --------------------------------------------------------------------------------------------------------------------------

/**
 * Rôle d'une session d'après `sessions.purpose` (§4.2 du plan) ; null pour une session cachée (classifier) ou un usage inconnu :
 * aucun fait. Une session « controle » (même enfant d'une conversation) est la ligne « Contrôle de sécurité ».
 */
export function sessionRole(purpose: string, parentId: string | null): SessionRole | null {
  switch (purpose) {
    case "controle":
      return "controle";
    case "equipe":
      return parentId === null ? "conversation" : "etape";
    case "chat":
      return parentId === null ? "conversation" : "delegation";
    default:
      return null;
  }
}

/** Vrai seulement pour le travail délégué par l'IA : jamais un contrôle de sécurité, une étape ni la conversation. */
export function isDelegatedWork(role: SessionRole | null): boolean {
  return role === "delegation";
}

// --- Contexte ---------------------------------------------------------------------------------------------------------------------

/** Événement opencode (bloc `payload` du flux global) : forme structurelle de OcEvent (server/opencode.ts). */
export interface FactEvent {
  id?: string;
  type: string;
  properties?: Record<string, unknown>;
}

/** Session vue par le cockpit (table sessions). */
export interface FactSession {
  rootId: string;
  parentId: string | null;
  /** sessions.purpose : chat, classifier, equipe, controle. */
  purpose: string;
  instance: SessionInstance;
}

export interface FactContext {
  /** Heure de réception de l'événement par le cockpit (ms). */
  receivedAt: number;
  /**
   * Session du cockpit, null si inconnue (aucun fait). `info` : la session portée par l'événement (session.created), que la file
   * du processeur n'a pas encore enregistrée au moment de la dérivation.
   */
  session(sessionId: string, info?: Readonly<Record<string, unknown>>): FactSession | null;
  /** Rôle d'un message déjà vu dans le flux (EventMemory), null s'il est inconnu. */
  messageRole(messageId: string): "user" | "assistant" | null;
  /** Genre de la ligne `prompts` d'un message que le cockpit a envoyé, null sinon (OriginContext.promptKind). */
  promptKind(messageId: string): string | null;
  /** Identifiant du premier message utilisateur de la session, null s'il est inconnu (EventMemory). */
  firstUserMessage(sessionId: string): string | null;
  /** Parties texte et subtask déjà vues d'un message utilisateur, réduites par originPartSummary ; vide si aucune (EventMemory). */
  userMessageParts(messageId: string): readonly OriginPart[];
  /** Messages utilisateur de la session auxquels aucune réponse de l'assistant n'a encore été vue (EventMemory). */
  unansweredUserMessages(sessionId: string): readonly string[];
  /**
   * Ce que seul l'amont sait (Salle OMO). Absent, les règles qui en dépendent restent muettes : aucune ne peut INVENTER un
   * réveil, une identité douteuse ni une tâche de fond. EventMemory fournit `identiteSuspecte` et `tacheDeFond` ; `noReply` est
   * porté par le processeur de la salle, seul à savoir comment un message a été déposé.
   */
  amont?: FactUpstream;
}

/** Délégation lancée en tâche de fond, retrouvée par la session de l'enfant (EventMemory). */
export interface BackgroundTask {
  callId: string;
  messageId: string;
  /** Session qui a confié le travail : c'est elle qui porte le fait « resultat ». */
  parent: string;
}

/** Connaissances de l'amont, toutes facultatives : une absence rend la règle muette, jamais bavarde. */
export interface FactUpstream {
  /** MO-1 : l'identité du message est douteuse (`messageID` déjà vu pour une autre session, partie ajoutée à un message clos). */
  identiteSuspecte?(messageId: string): boolean;
  /** F-h : le message a été déposé sans tour (`noReply`), donc sans appel d'IA ni coût. */
  noReply?(messageId: string): boolean;
  /** JP-3 : délégation en tâche de fond dont cette session est l'enfant, null sinon. */
  tacheDeFond?(childSessionId: string): BackgroundTask | null;
}

/** Parties gardées par message utilisateur ; au-delà, une partie inconnue est comptée (elle peut ne pas être synthétique). */
export const MEMORY_MAX_PARTS = 64;
/** Messages sans réponse gardés par session ; les plus anciens sont oubliés au-delà. */
export const MEMORY_MAX_UNANSWERED = 16;
/** Partie qui tient la place de celles qui n'ont pas pu être gardées : texte réel possible, donc jamais « synthétique ». */
const UNKNOWN_PART_KEY = " inconnue";
const UNKNOWN_PART: OriginPart = Object.freeze({ type: "text", synthetic: false });

/**
 * Mémoire bornée du flux, pour un FactContext : rôle des messages, premier message utilisateur de chaque session, parties des
 * messages utilisateur (réduites à ce que lit le classement d'origine, jamais leur texte) et messages encore sans réponse.
 */
export class EventMemory {
  readonly #limit: number;
  readonly #roles = new Map<string, "user" | "assistant">();
  readonly #firstUser = new Map<string, string>();
  readonly #userParts = new Map<string, Map<string, OriginPart>>();
  readonly #unanswered = new Map<string, string[]>();
  /** Session où chaque message a été vu la première fois (MO-1 : un `messageID` est un corrélateur, jamais une preuve). */
  readonly #messageSessions = new Map<string, string>();
  /** Messages utilisateur clos par la réponse de l'assistant : plus aucune partie de contenu ne doit s'y ajouter (MO-1). */
  readonly #closed = new Map<string, true>();
  /** Messages dont l'identité est douteuse (MO-1) : l'origine tombe en cas 7. */
  readonly #suspects = new Map<string, true>();
  /** Délégations en tâche de fond, par session d'enfant (JP-3). */
  readonly #fond = new Map<string, BackgroundTask>();

  constructor(limit = 20_000) {
    this.#limit = Math.max(1, Math.floor(limit));
  }

  /**
   * À appeler pour chaque événement, AVANT factsFromEvent : un message.updated fait connaître le rôle de son message (et, pour
   * une réponse de l'assistant, le message auquel elle répond) ; une partie texte ou subtask d'un message utilisateur est gardée.
   */
  observe(event: FactEvent): void {
    if (event.type === "message.part.updated") this.#observePart(event);
    else if (event.type === "message.updated") this.#observeMessage(event);
  }

  #observeMessage(event: FactEvent): void {
    const info = isRecord(event.properties?.info) ? event.properties.info : null;
    const id = idOf(info?.id);
    const sessionId = idOf(info?.sessionID);
    const role = info?.role;
    if (id === null || sessionId === null || (role !== "user" && role !== "assistant")) return;
    const seen = this.#roles.has(id);
    remember(this.#roles, id, role, this.#limit);
    // MO-1 : le même `messageID` annoncé pour une AUTRE session. `prompt_async` accepte tout identifiant commençant par `msg` et
    // écrit alors la partie dans la session du message emprunté, tout en annonçant celle qui était visée.
    const premiere = this.#messageSessions.get(id);
    if (premiere === undefined) remember(this.#messageSessions, id, sessionId, this.#limit);
    else if (premiere !== sessionId) remember(this.#suspects, id, true, this.#limit);
    if (role === "assistant") {
      this.#answered(sessionId, idOf(info?.parentID));
      return;
    }
    if (!this.#firstUser.has(sessionId)) remember(this.#firstUser, sessionId, id, this.#limit);
    // Un message utilisateur est republié plus tard (résumé) : seule sa première publication l'inscrit comme sans réponse.
    if (!seen) this.#awaitAnswer(sessionId, id);
  }

  #awaitAnswer(sessionId: string, messageId: string): void {
    let waiting = this.#unanswered.get(sessionId);
    if (!waiting) {
      if (this.#unanswered.size >= this.#limit) this.#unanswered.delete(this.#unanswered.keys().next().value as string);
      waiting = [];
      this.#unanswered.set(sessionId, waiting);
    }
    waiting.push(messageId);
    if (waiting.length > MEMORY_MAX_UNANSWERED) waiting.shift();
  }

  #answered(sessionId: string, parentId: string | null): void {
    const waiting = this.#unanswered.get(sessionId);
    const index = parentId === null || !waiting ? -1 : waiting.indexOf(parentId);
    if (index >= 0) waiting?.splice(index, 1);
    // Le message auquel l'assistant répond est clos : opencode publie TOUTES ses parties avant de créer la réponse.
    if (parentId !== null && this.#roles.get(parentId) === "user") remember(this.#closed, parentId, true, this.#limit);
  }

  #observePart(event: FactEvent): void {
    const part = isRecord(event.properties?.part) ? event.properties.part : null;
    if (part === null) return;
    if (part.type === "tool") {
      this.#observeTask(part);
      return;
    }
    if (part.type !== "text" && part.type !== "subtask") return;
    const messageId = idOf(part.messageID);
    if (messageId === null || this.#roles.get(messageId) !== "user") return;
    // MO-1 : une partie de contenu ajoutée à un message déjà clos, ou écrite dans une autre session que celle où le message a été
    // vu, est une anomalie ; seules les parties de CONTENU comptent (une partie de fichier ou d'outil publiée après la réponse
    // n'est pas une réécriture de la demande).
    if (this.#closed.has(messageId)) remember(this.#suspects, messageId, true, this.#limit);
    const partSession = idOf(part.sessionID) ?? idOf(event.properties?.sessionID);
    const premiere = this.#messageSessions.get(messageId);
    if (premiere !== undefined && partSession !== null && partSession !== premiere) remember(this.#suspects, messageId, true, this.#limit);
    let parts = this.#userParts.get(messageId);
    if (!parts) {
      if (this.#userParts.size >= this.#limit) this.#userParts.delete(this.#userParts.keys().next().value as string);
      parts = new Map();
      this.#userParts.set(messageId, parts);
    }
    const key = idOf(part.id) ?? `${UNKNOWN_PART_KEY} ${parts.size}`;
    if (parts.has(key) || parts.size < MEMORY_MAX_PARTS) parts.set(key, originPartSummary(part));
    else parts.set(UNKNOWN_PART_KEY, UNKNOWN_PART);
  }

  /**
   * Délégation lancée en tâche de fond (JP-3) : l'outil `task` de l'extension rend la main aussitôt (F-ab, « Background task
   * launched/continued ») et l'enfant continue. Seul `task` est suivi : c'est le seul outil dont ce module tire une consigne et
   * un résultat ; `call_omo_agent` est compté par les plafonds de la salle (L22) et reste à trancher pour L23c.
   * `sessionId` vaut « pending » quand l'extension n'a pas encore l'identifiant de l'enfant : ce n'est pas un identifiant.
   */
  #observeTask(part: Record<string, unknown>): void {
    if (nameOf(part.tool) !== "task") return;
    const state = isRecord(part.state) ? part.state : null;
    const input = isRecord(state?.input) ? state.input : {};
    const metadata = isRecord(state?.metadata) ? state.metadata : {};
    if (input.run_in_background !== true && metadata.run_in_background !== true) return;
    const enfant = metadata.sessionId === "pending" ? null : idOf(metadata.sessionId);
    const callId = idOf(part.callID);
    const messageId = idOf(part.messageID);
    const parent = idOf(part.sessionID);
    if (enfant === null || callId === null || messageId === null || parent === null) return;
    remember(this.#fond, enfant, { callId, messageId, parent }, this.#limit);
  }

  messageRole(messageId: string): "user" | "assistant" | null {
    return this.#roles.get(messageId) ?? null;
  }

  /** MO-1 : identité du message mise en doute (voir #messageSessions et #closed). */
  identiteSuspecte(messageId: string): boolean {
    return this.#suspects.has(messageId);
  }

  /** JP-3 : délégation en tâche de fond dont cette session est l'enfant, null sinon. */
  tacheDeFond(childSessionId: string): BackgroundTask | null {
    return this.#fond.get(childSessionId) ?? null;
  }

  /** Connaissances à passer au contexte des faits (FactContext.amont) ; `noReply` reste à la charge du processeur de la salle. */
  amont(): FactUpstream {
    return { identiteSuspecte: (id) => this.identiteSuspecte(id), tacheDeFond: (id) => this.tacheDeFond(id) };
  }

  firstUserMessage(sessionId: string): string | null {
    return this.#firstUser.get(sessionId) ?? null;
  }

  userMessageParts(messageId: string): readonly OriginPart[] {
    return [...(this.#userParts.get(messageId)?.values() ?? [])];
  }

  unansweredUserMessages(sessionId: string): readonly string[] {
    return [...(this.#unanswered.get(sessionId) ?? [])];
  }
}

function remember<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
  if (map.has(key)) return;
  if (map.size >= limit) map.delete(map.keys().next().value as string);
  map.set(key, value);
}

// --- Événement → faits ------------------------------------------------------------------------------------------------------------

/** Identifiant opencode (shared/ids.ts) qui n'a pas la forme d'un secret connu (redactSecrets), sinon null. */
const idOf = (value: unknown): string | null => (typeof value === "string" && ID_RE.test(value) && redactSecrets(value) === value ? value : null);
/** Nom d'assistant, d'outil, de commande ou d'erreur : nom technique, sinon null. */
const nameOf = (value: unknown): string | null => (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : null);
const countOf = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

/** Catégories de l'anneau d'outils du zoom 3 (§5.7.4) ; « confier » est porté par les faits consigne et resultat. */
const TOOL_CATEGORIES: Readonly<Record<string, string>> = {
  read: "lire",
  webfetch: "lire",
  glob: "chercher",
  grep: "chercher",
  list: "chercher",
  codesearch: "chercher",
  websearch: "chercher",
  edit: "modifier",
  write: "modifier",
  multiedit: "modifier",
  patch: "modifier",
  apply_patch: "modifier",
  bash: "commande",
  question: "question",
};

/** Catégorie d'outil du zoom 3 : lire, chercher, modifier, commande, question, confier (task) ou autre. */
export function toolCategory(tool: string): string {
  return tool === "task" ? "confier" : (TOOL_CATEGORIES[tool] ?? "autre");
}

/**
 * Clé de regroupement d'un chemin de fichier (FNV-1a, deux passes de 32 bits, 16 chiffres hexadécimaux) : relie les faits d'un
 * même fichier ou dossier (tuiles du zoom 3) sans garder le chemin. Non secrète et réversible par essai : ce n'est pas une
 * empreinte de sécurité ; le nom affiché est relu dans la partie d'outil (ref = callId), passé par redactSecrets.
 */
export function pathKey(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

function folderOf(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/(.)\/$/, "$1");
  const cut = normalized.lastIndexOf("/");
  return cut <= 0 ? "/" : normalized.slice(0, cut);
}

type FactData = Record<string, unknown>;

/** Fabrique des faits d'une session ; null si la session est inconnue, cachée ou mal identifiée. */
function sessionFacts(ctx: FactContext, sessionId: string | null, at: number, info?: Record<string, unknown>) {
  if (sessionId === null) return null;
  const session = ctx.session(sessionId, info);
  if (!session || idOf(session.rootId) === null) return null;
  const role = sessionRole(session.purpose, session.parentId);
  if (role === null) return null;
  const fact = (kind: ActivityFactKind, ref: string | null, data: FactData): ActivityFact => {
    const clean: Record<string, FactValue> = {};
    // Seconde barrière : toute valeur hors garde devient null (les extracteurs ne lisent déjà que des champs non textuels).
    for (const [key, value] of Object.entries(data)) clean[key] = dataValueAllowed(value) ? value : null;
    return { rootId: session.rootId, sessionId, kind, ref: idOf(ref), data: clean, at };
  };
  return { sessionId, session, role, fact };
}

const STATUS_ETATS: Readonly<Record<string, string>> = { busy: "occupee", idle: "repos", retry: "nouvelle-tentative" };

/** Faits d'un événement opencode (§5.7.3). Aucun appel réseau, aucune écriture : le magasin (L4b) persiste le résultat. */
export function factsFromEvent(event: FactEvent, ctx: FactContext): ActivityFact[] {
  const p = event.properties;
  if (!isRecord(p)) return [];
  const at = eventTime(event.id, ctx.receivedAt);
  switch (event.type) {
    case "session.created": {
      const info = isRecord(p.info) ? p.info : undefined;
      const id = idOf(info?.id) ?? idOf(p.sessionID);
      const s = sessionFacts(ctx, id, at, info);
      if (!s) return [];
      return [s.fact("statut", null, { etat: "creee", role: s.role, parent: s.session.parentId, agent: nameOf(info?.agent), instance: s.session.instance })];
    }
    case "session.status": {
      const status = isRecord(p.status) ? p.status : null;
      const etat = typeof status?.type === "string" ? STATUS_ETATS[status.type] : undefined;
      const s = etat ? sessionFacts(ctx, idOf(p.sessionID), at) : null;
      if (!s || !etat) return [];
      const facts = [s.fact("statut", null, etat === "nouvelle-tentative" ? { etat, tentative: countOf(status?.attempt) } : { etat })];
      // Session au repos : un message resté sans réponse (sans réponse demandée, erreur avant l'appel) a toutes ses parties.
      if (etat === "repos") {
        for (const messageId of ctx.unansweredUserMessages(s.sessionId)) facts.push(...originFacts(messageId, s, ctx));
        facts.push(...backgroundResultFacts(s.sessionId, at, ctx));
      }
      return facts;
    }
    case "message.updated": {
      // Réponse de l'assistant : opencode ne la crée qu'après avoir publié toutes les parties du message auquel elle répond.
      const info = isRecord(p.info) ? p.info : null;
      const parentId = info?.role === "assistant" ? idOf(info.parentID) : null;
      const s = parentId === null ? null : sessionFacts(ctx, idOf(info?.sessionID), at);
      return s && parentId !== null ? originFacts(parentId, s, ctx) : [];
    }
    case "session.error": {
      const s = sessionFacts(ctx, idOf(p.sessionID), at);
      const error = isRecord(p.error) ? p.error : null;
      return s ? [s.fact("statut", null, { etat: "erreur", erreur: nameOf(error?.name) })] : [];
    }
    case "session.compacted": {
      const s = sessionFacts(ctx, idOf(p.sessionID), at);
      return s ? [s.fact("statut", null, { etat: "memoire-resumee" })] : [];
    }
    case "todo.updated": {
      const s = sessionFacts(ctx, idOf(p.sessionID), at);
      if (!s || !Array.isArray(p.todos)) return [];
      const faites = p.todos.filter((todo) => isRecord(todo) && todo.status === "completed").length;
      return [s.fact("statut", null, { etat: "taches", faites, total: p.todos.length })];
    }
    case "permission.asked": {
      const id = idOf(p.id);
      const s = id ? sessionFacts(ctx, idOf(p.sessionID), at) : null;
      if (!s) return [];
      const tool = isRecord(p.tool) ? p.tool : null;
      const metadata = isRecord(p.metadata) ? p.metadata : null;
      const permission = typeof p.permission === "string" && /^[a-z_]{1,32}$/.test(p.permission) ? p.permission : null;
      return [
        s.fact("attente", id, {
          permission,
          messageId: idOf(tool?.messageID),
          callId: idOf(tool?.callID),
          // Seul le nom de l'assistant demandé par une délégation est gardé ; les motifs (chemins, commandes) jamais.
          agent: permission === "task" ? nameOf(metadata?.subagent_type) : null,
        }),
      ];
    }
    case "permission.replied": {
      const id = idOf(p.requestID);
      const s = id ? sessionFacts(ctx, idOf(p.sessionID), at) : null;
      const reponse = p.reply === "once" || p.reply === "always" || p.reply === "reject" ? p.reply : null;
      return s && reponse ? [s.fact("reponse", id, { reponse })] : [];
    }
    case "message.part.updated":
      return isRecord(p.part) ? partFacts(p.part, idOf(p.sessionID), at, ctx) : [];
    default:
      return [];
  }
}

const TOOL_PHASES: Readonly<Record<string, string>> = { pending: "prepare", running: "en-cours", completed: "termine", error: "erreur" };

type Facts = NonNullable<ReturnType<typeof sessionFacts>>;

function originContext(messageId: string, s: Facts, ctx: FactContext): OriginContext {
  return {
    promptKind: ctx.promptKind(messageId),
    firstUserOfChild: s.session.parentId !== null && ctx.firstUserMessage(s.sessionId) === messageId,
    instance: s.session.instance,
    racine: s.session.parentId === null,
    noReply: ctx.amont?.noReply?.(messageId) === true,
    identiteSuspecte: ctx.amont?.identiteSuspecte?.(messageId) === true,
  };
}

/**
 * Fait « origine », et pour le cas 4 le fait « reveil » qui va avec (JP-2 : résultat déposé, lu au prochain tour, sans appel
 * d'IA ni coût — aucun fait « statut appel » n'est écrit ici, il ne vient que d'une partie `step-start`).
 */
function originEventFacts(messageId: string, s: Facts, verdict: OriginVerdict, parts: readonly OriginPart[]): ActivityFact[] {
  const data: FactData = { origine: verdict.origine, cas: verdict.cas, messageId };
  if (verdict.relance !== undefined) data.relance = verdict.relance;
  // JP-4, dans la salle : la consigne réelle de l'enfant est ce message (`messageId`) ; `hook` dit qu'un hook l'a préfixée, pour
  // que la partie ajoutée soit marquée « ajouté par l'extension ». Hors de la salle, la clé n'existe pas.
  if (verdict.cas === 3 && s.session.instance === "omo") data.hook = partsCarryHookPrefix(parts);
  const facts = [s.fact("origine", messageId, data)];
  if (verdict.cas === 4) facts.push(s.fact("reveil", messageId, { etat: "depose", messageId }));
  return facts;
}

/**
 * Origine d'un message utilisateur dont toutes les parties sont connues (§5.7.2), classée sur le message ENTIER : les cas 4 à 7
 * dépendent de toutes ses parties (un message n'est synthétique que si toutes ses parties texte le sont). Aucun fait si aucune
 * partie texte ou subtask n'a été vue. Rendu à chaque clôture vue : le même verdict, écarté ensuite par FactDeduper.
 */
/**
 * Résultat d'une tâche de fond, au repos de l'ENFANT (JP-3) : le faisceau bleu part à la fin de l'enfant, jamais sur
 * « Background task launched/continued ». Le fait est porté par la session qui a confié le travail, comme tout résultat.
 * Sans amont (instance principale), aucune tâche de fond n'est connue : rien n'est écrit.
 */
function backgroundResultFacts(childSessionId: string, at: number, ctx: FactContext): ActivityFact[] {
  const fond = ctx.amont?.tacheDeFond?.(childSessionId) ?? null;
  const s = fond === null ? null : sessionFacts(ctx, fond.parent, at);
  if (fond === null || !s) return [];
  return [s.fact("resultat", fond.callId, { etat: "rendu", callId: fond.callId, messageId: fond.messageId, enfant: childSessionId })];
}

function originFacts(messageId: string, s: Facts, ctx: FactContext): ActivityFact[] {
  if (ctx.messageRole(messageId) !== "user") return [];
  const parts = ctx.userMessageParts(messageId);
  return parts.length === 0 ? [] : originEventFacts(messageId, s, originVerdict(parts, originContext(messageId, s, ctx)), parts);
}

function partFacts(part: Record<string, unknown>, eventSessionId: string | null, at: number, ctx: FactContext): ActivityFact[] {
  const s = sessionFacts(ctx, idOf(part.sessionID) ?? eventSessionId, at);
  const messageId = idOf(part.messageID);
  if (!s || messageId === null) return [];
  switch (part.type) {
    case "step-start":
      return [s.fact("statut", messageId, { etat: "appel", messageId })];
    case "step-finish": {
      const cout = typeof part.cost === "number" && Number.isFinite(part.cost) && part.cost >= 0 ? part.cost : null;
      return [s.fact("statut", messageId, { etat: "appel-fini", messageId, cout, raison: nameOf(part.reason) })];
    }
    case "text":
    case "subtask": {
      const role = ctx.messageRole(messageId);
      if (role === "assistant") return part.type === "text" ? [s.fact("statut", messageId, { etat: "redige", messageId })] : [];
      if (role !== "user") return [];
      // Cas 1 à 3 : le contexte suffit, le verdict part dès la première partie. Sinon il attend la clôture du message (originFacts) :
      // classé sur les parties déjà arrivées, il dépendrait de leur ordre, et FactDeduper garderait le premier fait.
      const verdict = contextVerdict(originContext(messageId, s, ctx));
      return verdict === null ? [] : originEventFacts(messageId, s, verdict, ctx.userMessageParts(messageId));
    }
    case "tool":
      return toolFacts(part, messageId, s);
    default:
      return [];
  }
}

function toolFacts(part: Record<string, unknown>, messageId: string, s: Facts): ActivityFact[] {
  const tool = nameOf(part.tool);
  const callId = idOf(part.callID);
  const state = isRecord(part.state) ? part.state : null;
  const status = typeof state?.status === "string" ? state.status : "";
  if (tool === null || callId === null || !Object.hasOwn(TOOL_PHASES, status)) return [];
  const input = isRecord(state?.input) ? state.input : {};
  const metadata = isRecord(state?.metadata) ? state.metadata : {};
  const interrupted = metadata.interrupted === true;
  if (tool === "task") return taskFacts({ input, metadata, status, interrupted }, messageId, callId, s);
  // Un outil en préparation (arguments en cours d'écriture) ne change rien à l'affichage : aucun fait.
  if (status === "pending") return [];
  const phase = status === "error" && interrupted ? "interrompu" : TOOL_PHASES[status];
  const filePath = typeof input.filePath === "string" && input.filePath !== "" ? input.filePath : null;
  return [
    s.fact("statut", callId, {
      etat: "outil",
      outil: toolCategory(tool),
      nom: tool,
      phase,
      callId,
      messageId,
      fichier: filePath === null ? null : pathKey(filePath),
      dossier: filePath === null ? null : pathKey(folderOf(filePath)),
    }),
    ...carnetFacts(filePath, messageId, callId, tool, phase, s),
  ];
}

// --- Salle OMO : consigne (JP-7), tâche de fond (JP-3), reprise et carnet partagé (JP-6) -------------------------------------------

/** Longueur maximale d'un chemin de carnet gardé dans un fait (la garde `data` en accepte 128). */
export const CARNET_CHEMIN_MAX = 100;

/** Dossiers du carnet partagé et des plans, relatifs à la racine d'un projet (§5.7.3, JP-6 ; `omo-precheck-rules.ts`). */
const CARNET_DOSSIERS: readonly string[] = [".omo/notepads/", ".omo/plans/"];

/** Outils qui MODIFIENT un fichier ; les autres ne font que le lire (tuile au contour bleu contre tuile pleine, §5.7.4). */
const OUTILS_MODIFIENT = new Set(["edit", "write", "multiedit", "patch", "apply_patch"]);

/**
 * Chemin du carnet partagé porté par un chemin de fichier : la partie qui commence à `.omo/notepads/` ou `.omo/plans/`, jamais
 * ce qui la précède (le nom du projet vient de l'utilisateur, il n'a pas sa place dans un fait). null hors du carnet.
 */
export function carnetChemin(filePath: string): string | null {
  const normalized = filePath.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  for (const dossier of CARNET_DOSSIERS) {
    const cut = normalized.indexOf(dossier);
    const debut = cut === 0 || (cut > 0 && normalized[cut - 1] === "/") ? cut : -1;
    if (debut < 0) continue;
    const chemin = normalized.slice(debut);
    // Ni remontée, ni nom vide, ni chemin trop long : ce qui n'est pas reconnu reste hors du carnet plutôt que d'être deviné.
    if (chemin.length > CARNET_CHEMIN_MAX || chemin.endsWith("/") || chemin.split("/").includes("..")) return null;
    return chemin;
  }
  return null;
}

/**
 * Fait « carnet » (JP-6) : un agent a lu ou modifié le carnet partagé ou un plan. Le chemin RELATIF est gardé — c'est la tuile
 * de la station « Carnet partagé et plan » —, jamais le contenu. Hors de la Salle OMO, la station reste vide : aucun fait.
 */
function carnetFacts(filePath: string | null, messageId: string, callId: string, tool: string, phase: string | undefined, s: Facts): ActivityFact[] {
  if (s.session.instance !== "omo" || filePath === null || phase !== "termine") return [];
  const chemin = carnetChemin(filePath);
  if (chemin === null) return [];
  return [
    s.fact("carnet", callId, {
      etat: OUTILS_MODIFIENT.has(tool) ? "modifie" : "lu",
      chemin,
      fichier: pathKey(filePath),
      dossier: pathKey(folderOf(filePath)),
      callId,
      messageId,
    }),
  ];
}

/** Nom d'IA (`fournisseur/modèle`) lu dans les métadonnées d'une consigne de la salle ; null si la forme n'est pas reconnue. */
function iaDeMetadata(value: unknown): string | null {
  if (typeof value === "string") return nameOf(value) ?? (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : null);
  if (!isRecord(value)) return null;
  const fournisseur = nameOf(value.providerID);
  const modele = nameOf(value.modelID);
  return fournisseur === null || modele === null ? null : `${fournisseur}/${modele}`;
}

/**
 * Métadonnées d'une consigne de la salle (JP-7, `omo:tools/delegate-task/sync-task-metadata.ts`) : catégorie, IA choisie, NOMBRE
 * de compétences chargées et « attend le résultat » ou « en tâche de fond ». Les noms des compétences et le texte de la consigne
 * ne sont jamais gardés. Hors de la salle, aucune de ces clés n'est écrite : les faits de l'instance principale ne bougent pas.
 */
function consigneOmo(input: Record<string, unknown>, metadata: Record<string, unknown>, s: Facts): FactData {
  if (s.session.instance !== "omo") return {};
  const skills = Array.isArray(metadata.load_skills) ? metadata.load_skills : input.load_skills;
  const competences = Array.isArray(skills) ? skills.length : null;
  return {
    categorie: nameOf(metadata.category) ?? nameOf(input.category),
    ia: iaDeMetadata(metadata.model),
    competences,
    fond: input.run_in_background === true || metadata.run_in_background === true,
  };
}

/** Vrai si la consigne reprend une tâche existante : `task_id` (task d'opencode) ou `session_id` (délégation de l'extension). */
const tacheReprise = (input: Record<string, unknown>): string | null =>
  (typeof input.task_id === "string" && input.task_id !== "" ? idOf(input.task_id) : null) ??
  (typeof input.session_id === "string" && input.session_id !== "" ? idOf(input.session_id) : null);

interface TaskState {
  input: Record<string, unknown>;
  metadata: Record<string, unknown>;
  status: string;
  interrupted: boolean;
}

/**
 * Faits d'une partie `task` : consigne préparée, consigne envoyée (avec les métadonnées de la salle), reprise et résultat.
 * JP-3 : une tâche de fond se ferme AUSSITÔT (« Background task launched/continued ») sans porter le résultat ; le résultat part
 * à la fin de l'enfant (`session.idle`), jamais sur cette clôture.
 */
function taskFacts(state: TaskState, messageId: string, callId: string, s: Facts): ActivityFact[] {
  const { input, metadata, status, interrupted } = state;
  const enfant = metadata.sessionId === "pending" ? null : idOf(metadata.sessionId);
  if (status === "pending") return [s.fact("consigne", callId, { etat: "prepare", callId, messageId })];
  const fond = input.run_in_background === true || metadata.run_in_background === true;
  if (status === "running") {
    if (enfant === null) return [];
    // Source « raccourci » : `command` rempli, comme le fait opencode pour un raccourci `subtask`. L'IA peut aussi le remplir
    // (paramètre facultatif de l'outil `task`) : seule l'absence de demande pour cet appel prouve un lancement sans confirmation.
    const commande = nameOf(input.command);
    const tache = tacheReprise(input);
    const facts = [
      s.fact("consigne", callId, {
        etat: "envoyee",
        callId,
        messageId,
        enfant,
        agent: nameOf(input.subagent_type),
        source: commande === null ? "ia" : "raccourci",
        commande,
        reprise: tache !== null,
        ...consigneOmo(input, metadata, s),
      }),
    ];
    // L'enfant n'est pas neuf : la légende « Il ne voit pas votre conversation… » ne s'applique plus (§5.8).
    if (tache !== null) facts.push(s.fact("reprise", callId, { callId, messageId, enfant, tache }));
    return facts;
  }
  // Tâche de fond : « lancée » n'est pas « rendue ». Le résultat vient du repos de l'enfant (factsFromEvent, session.status).
  if (fond && !interrupted && status !== "error") return [];
  let etat = "rendu";
  if (status === "error") etat = interrupted ? "interrompu" : "echec";
  return [s.fact("resultat", callId, { etat, callId, messageId, enfant })];
}

/** Session concernée par un événement (propriété, partie ou info), null sinon : l'appelant peut l'enregistrer avant de dériver. */
export function eventSessionId(event: FactEvent): string | null {
  const p = event.properties;
  if (!isRecord(p)) return null;
  if (isRecord(p.part)) return idOf(p.part.sessionID) ?? idOf(p.sessionID);
  if (isRecord(p.info)) return idOf(p.sessionID) ?? idOf(event.type.startsWith("session.") ? p.info.id : p.info.sessionID);
  return idOf(p.sessionID);
}

// --- Fusion du direct et du différé ----------------------------------------------------------------------------------------------

/** États d'activité d'une session : un seul fait par changement (occupée, au repos, nouvelle tentative, erreur). */
const ACTIVITY_ETATS = new Set(["occupee", "repos", "nouvelle-tentative", "erreur"]);

/**
 * Clé d'unicité d'un fait d'événement : le premier fait d'une clé l'emporte (une origine par message, une consigne préparée puis
 * envoyée par appel, un résultat par appel, une attente et une réponse par demande, un appel d'IA par message). null : fait d'état,
 * gardé seulement s'il change l'état de sa session (FactDeduper).
 */
export function factKey(fact: ActivityFact): string | null {
  const etat = fact.data.etat;
  switch (fact.kind) {
    case "origine":
    case "resultat":
    case "attente":
    case "reponse":
      return fact.ref === null ? null : `${fact.kind}|${fact.sessionId}|${fact.ref}`;
    case "consigne":
      return fact.ref === null ? null : `consigne|${fact.sessionId}|${fact.ref}|${String(etat)}`;
    case "statut":
      if (etat === "creee") return `statut|creee|${fact.sessionId}`;
      if (fact.ref === null) return null;
      if (etat === "appel" || etat === "appel-fini" || etat === "redige") return `statut|${etat}|${fact.sessionId}|${fact.ref}`;
      if (etat === "outil") return `statut|outil|${fact.sessionId}|${fact.ref}|${String(fact.data.phase)}`;
      return null;
    default:
      return null;
  }
}

/** Filtre de doublons borné, pour un flux : un fait à clé déjà vue, ou un état identique au précédent de sa session, est écarté. */
export class FactDeduper {
  readonly #limit: number;
  readonly #keys = new Map<string, true>();
  readonly #last = new Map<string, string>();

  constructor(limit = 50_000) {
    this.#limit = Math.max(1, Math.floor(limit));
  }

  /** Vrai si le fait est nouveau (à garder) ; il est alors retenu. */
  accept(fact: ActivityFact): boolean {
    const key = factKey(fact);
    if (key !== null) {
      if (this.#keys.has(key)) return false;
      remember(this.#keys, key, true, this.#limit);
      return true;
    }
    const etat = fact.data.etat;
    const family = fact.kind === "statut" && typeof etat === "string" && ACTIVITY_ETATS.has(etat) ? "activite" : String(etat ?? "");
    const slot = `${fact.kind}|${fact.sessionId}|${family}`;
    const value = JSON.stringify([fact.ref, Object.entries(fact.data).sort(([a], [b]) => a.localeCompare(b, "en"))]);
    if (this.#last.get(slot) === value) return false;
    this.#last.delete(slot);
    if (this.#last.size >= this.#limit) this.#last.delete(this.#last.keys().next().value as string);
    this.#last.set(slot, value);
    return true;
  }
}

/** Faits sans doublon, dans leur ordre. */
export function dedupeFacts(facts: readonly ActivityFact[]): ActivityFact[] {
  const deduper = new FactDeduper(Math.max(1, facts.length * 2));
  return facts.filter((fact) => deduper.accept(fact));
}

/** Identité d'un fait accepté par le magasin : un même événement donne toujours le même fait (même heure, mêmes données). */
function factIdentity(fact: ActivityFact): string {
  return JSON.stringify([fact.sessionId, fact.kind, fact.ref, fact.at, Object.entries(fact.data).sort(([a], [b]) => a.localeCompare(b, "en"))]);
}

/**
 * Fusion du différé (faits persistés, dans l'ordre du magasin) et du direct (faits `activite.fait` reçus depuis l'abonnement),
 * tous deux déjà filtrés par le magasin : les persistés d'abord, puis le direct ; un fait identique à un fait déjà gardé
 * (recouvrement) est écarté. Doublons par identité SEULEMENT, comme le direct (activity.ts, applyEvent) : la règle « même état que
 * le précédent » (FactDeduper) ne sert qu'au flux côté serveur ; appliquée ici, elle écarterait un fait persisté que le direct a
 * montré (deux arrêts de même contenu, un état réécrit après un redémarrage du cockpit) et le différé ne vaudrait plus le direct.
 */
export function mergeFacts(persisted: readonly ActivityFact[], live: readonly ActivityFact[]): ActivityFact[] {
  const known = new Set<string>();
  const out: ActivityFact[] = [];
  for (const fact of [...persisted, ...live]) {
    const identity = factIdentity(fact);
    if (known.has(identity)) continue;
    known.add(identity);
    out.push(fact);
  }
  return out;
}
