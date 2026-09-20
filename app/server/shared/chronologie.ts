// Chronologie du Déroulé (spécification §2.1 l.63, §5.1 l.883-884, §5.5 l.920 ; plan d'exécution it5, fiche L47a, D-5-09) : un seul
// modèle, celui de l'itération 1. Les lignes et les appels d'IA viennent de `timeline` (shared/activity.ts, faits `activity_facts`) ;
// les lignes `usage` du registre des coûts n'apportent QUE l'IA, la réflexion et les jetons, rapprochées par identifiant de message.
// Un message repère (aucune partie step-start ni step-finish, donc aucun appel dans le Déroulé) n'est jamais un appel, même si une
// ligne `usage` existe pour lui ; un appel sans ligne `usage` garde ses jetons à `null` (non enregistrés).
// Rend des CODES et des NOMBRES : aucune phrase (elles sont dans construction-texts.ts, section `avance`, où « jeton » est permis).
// Le module ne connaît pas le mode : la chronologie est un réglage du mode Avancé, et c'est l'interface (L47b) qui la masque.
// Module pur (server/shared) : aucun module node, aucun accès à process, ni horloge ni aléa — `now` est un paramètre.
import { activityStatus, type ActivityState, liveRows, type TimelineCall, type TimelineRow, timeline } from "./activity.ts";
import type { ActorState, FactValue, SessionRole } from "./activity-types.ts";
import { toolCategory } from "./activity-facts.ts";
import type { DecisionVerdict } from "./autonomy-types.ts";

// --- Types ------------------------------------------------------------------------------------------------------------------------
// Forme de construction-types.ts, comparée au train de V0 : `construction-types.ts` (T5a) est de la même vague, ces déclarations
// locales tiennent sa place jusqu'au croisement du train, qui remplace ce bloc par un import.

/** Ligne du registre des coûts (table `usage`) d'une conversation, servie par la route de la chronologie (L47b). */
export interface ChronologieUsageRow {
  messageId: string;
  sessionId: string;
  agent: string;
  providerId: string;
  modelId: string;
  variant: string | null;
  tokensInput: number;
  tokensOutput: number;
  tokensReasoning: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  cost: number;
  createdAt: number;
  completedAt: number | null;
}

/** Appel d'IA d'une ligne ; jetons `null` = non enregistrés (aucune ligne `usage` pour ce message). */
export interface ChronologieCall {
  messageId: string;
  start: number;
  /** null : appel en cours. */
  end: number | null;
  /** Identifiant d'IA (`usage.model_id`), jamais un libellé. */
  model: string | null;
  /** Réflexion écrite (`usage.variant`), null si aucune. */
  variant: string | null;
  /** Entrée = input + cache lu + cache écrit (comme `ledger.summary`). */
  tokensIn: number | null;
  /** Sortie = output + réflexion (comme `ledger.summary`). */
  tokensOut: number | null;
  tokensCache: number | null;
  tokensReasoning: number | null;
  /** Coût du Déroulé (fait `appel-fini`), jamais recalculé ici. */
  cost: number;
}

/** Repère posé sur une ligne : une catégorie d'outil, le rang d'une nouvelle tentative, un verdict de décision, une attente de vous. */
export interface ChronologieTick {
  at: number;
  genre: "outil" | "tentative" | "decision" | "attente";
  /** Code seulement : catégorie d'outil, rang en chiffres, verdict, ou ATTENTE_CODE. */
  code: string;
}

/** Ligne de la chronologie : celle du Déroulé de l'itération 1, même clé et même rang. */
export interface ChronologieRow {
  key: string;
  sessionId: string;
  depth: number;
  role: SessionRole;
  state: ActorState;
  start: number | null;
  end: number | null;
  calls: ChronologieCall[];
  ticks: ChronologieTick[];
  /** Clé du groupe de délégations répétées, null si la ligne n'en fait pas partie. */
  groupe: string | null;
}

/** Délégations répétées : au moins GROUPE_MIN lignes du même assistant sous le même parent (« ×n »). */
export interface ChronologieGroup {
  key: string;
  agent: string;
  count: number;
  rowKeys: string[];
}

/** Vue rendue par `chronologie` : bornes, curseur du direct, lignes, groupes et « Déroulé partiel ». */
export interface ChronologieView {
  start: number | null;
  end: number | null;
  /** `now` tant qu'une ligne est en cours, null sinon (et null si `now` est null). */
  curseur: number | null;
  rows: ChronologieRow[];
  groupes: ChronologieGroup[];
  partiel: boolean;
}

// --- Constantes -------------------------------------------------------------------------------------------------------------------

/** Délégations du même assistant sous le même parent à partir desquelles un groupe est formé. */
export const GROUPE_MIN = 2;
/** Code d'un repère d'attente de votre accord (barre `attente-vous` du Déroulé). */
export const ATTENTE_CODE = "vous";

/** États d'acteur clos : aucune ligne dans un de ces états ne tient le curseur du direct. */
const CLOS: ReadonlySet<string> = new Set<ActorState>(["pas-commence", "termine", "echec", "arrete", "jamais-demarre", "non-choisi"]);
/** Verdicts d'une décision d'autonomie (`autonomy_decisions.verdict`, fait « decision ») : tout autre code est écarté. */
const VERDICTS: ReadonlySet<string> = new Set<DecisionVerdict>(["auto", "attente", "refus-auto", "non-controle", "refus-interdit"]);
/** Rang d'affichage des repères posés au même instant. */
const GENRE_ORDER: Readonly<Record<ChronologieTick["genre"], number>> = { attente: 0, outil: 1, tentative: 2, decision: 3 };

const strOf = (value: FactValue | undefined): string | null => (typeof value === "string" && value !== "" ? value : null);
const countOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
const rankOf = (value: FactValue | undefined): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : 1);
const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// --- Lignes `usage` ---------------------------------------------------------------------------------------------------------------

/** Lignes `usage` par identifiant de message ; la première l'emporte (un message n'a qu'un appel d'IA). */
function indexUsage(usage: readonly ChronologieUsageRow[]): Map<string, ChronologieUsageRow> {
  const byMessage = new Map<string, ChronologieUsageRow>();
  for (const row of usage) {
    if (typeof row?.messageId !== "string" || row.messageId === "" || byMessage.has(row.messageId)) continue;
    byMessage.set(row.messageId, row);
  }
  return byMessage;
}

/**
 * Appel du Déroulé enrichi de sa ligne `usage`. La ligne n'est lue que si elle porte la même session : une ligne d'une autre
 * session (identifiant de message recyclé, réponse tronquée) laisse les jetons à `null` plutôt que de les attribuer à tort.
 */
function mergeCall(call: TimelineCall, sessionId: string, row: ChronologieUsageRow | undefined): ChronologieCall {
  const base = { messageId: call.messageId, start: call.start, end: call.end, cost: call.cost };
  if (row === undefined || row.sessionId !== sessionId) {
    return { ...base, model: null, variant: null, tokensIn: null, tokensOut: null, tokensCache: null, tokensReasoning: null };
  }
  const cache = countOf(row.tokensCacheRead) + countOf(row.tokensCacheWrite);
  const reasoning = countOf(row.tokensReasoning);
  return {
    ...base,
    model: strOf(row.modelId),
    variant: strOf(row.variant),
    tokensIn: countOf(row.tokensInput) + cache,
    tokensOut: countOf(row.tokensOutput) + reasoning,
    tokensCache: cache,
    tokensReasoning: reasoning,
  };
}

// --- Repères ----------------------------------------------------------------------------------------------------------------------

/**
 * Repères tirés des faits, par session (formes de `activity-facts.ts`) : outils (`statut` à catégorie d'outil, une fois par appel
 * d'outil, quelle que soit sa phase), nouvelles tentatives (`statut` retry, avec leur rang) et décisions (`decision`, par leur
 * verdict). Un fait d'une autre racine est écarté, comme dans le réducteur.
 */
function ticksBySession(state: ActivityState): Map<string, ChronologieTick[]> {
  const bySession = new Map<string, ChronologieTick[]>();
  const vus = new Set<string>();
  const push = (sessionId: string, tick: ChronologieTick) => {
    const list = bySession.get(sessionId);
    if (list) list.push(tick);
    else bySession.set(sessionId, [tick]);
  };
  for (const fact of state.facts) {
    if (fact.rootId !== state.rootId) continue;
    const { data, at } = fact;
    if (fact.kind === "decision") {
      const verdict = strOf(data.verdict);
      if (verdict === null || !VERDICTS.has(verdict)) continue;
      const key = fact.ref === null ? null : `decision|${fact.sessionId}|${fact.ref}`;
      if (key !== null && vus.has(key)) continue;
      if (key !== null) vus.add(key);
      push(fact.sessionId, { at, genre: "decision", code: verdict });
      continue;
    }
    if (fact.kind !== "statut") continue;
    if (data.etat === "nouvelle-tentative") {
      push(fact.sessionId, { at, genre: "tentative", code: String(rankOf(data.tentative)) });
      continue;
    }
    if (data.etat !== "outil") continue;
    const callId = strOf(data.callId) ?? fact.ref;
    const nom = strOf(data.nom);
    const code = nom === null ? strOf(data.outil) : toolCategory(nom);
    if (callId === null || code === null) continue;
    const key = `outil|${fact.sessionId}|${callId}`;
    if (vus.has(key)) continue;
    vus.add(key);
    push(fact.sessionId, { at, genre: "outil", code });
  }
  return bySession;
}

/** Repères d'une ligne : ceux de sa session, plus une attente par barre `attente-vous` du Déroulé, dans l'ordre du temps. */
function rowTicks(ligne: TimelineRow, bySession: ReadonlyMap<string, ChronologieTick[]>): ChronologieTick[] {
  // Une délégation sans session porte la session qui délègue : ses faits restent sur la ligne de celle-ci, jamais en double.
  const ticks: ChronologieTick[] = ligne.sansSession ? [] : [...(bySession.get(ligne.sessionId) ?? [])];
  for (const bar of ligne.bars) if (bar.kind === "attente-vous") ticks.push({ at: bar.start, genre: "attente", code: ATTENTE_CODE });
  return ticks.sort((a, b) => a.at - b.at || GENRE_ORDER[a.genre] - GENRE_ORDER[b.genre] || compareKeys(a.code, b.code));
}

// --- Vue --------------------------------------------------------------------------------------------------------------------------

/**
 * Chronologie d'une conversation : lignes et appels du Déroulé de l'itération 1, jetons du registre, repères, groupes de
 * délégations répétées, bornes et curseur. Pure et déterministe : deux appels sur le même état rendent des objets égaux.
 * `now` ne sert qu'au curseur et à la borne de fin d'une ligne en cours ; null hors du direct (Archives, « Revoir »).
 */
export function chronologie(state: ActivityState, usage: readonly ChronologieUsageRow[], now: number | null): ChronologieView {
  const lignes = timeline(state);
  // `liveRows(state, 0)` rend les mêmes clés dans le même ordre que `timeline` : seul l'assistant et le parent y sont lus.
  const traits = new Map(liveRows(state, 0).map((row) => [row.key, { agent: row.agent, parentId: row.parentId }]));
  const byMessage = indexUsage(usage);
  const bySession = ticksBySession(state);
  const rows: ChronologieRow[] = [];
  const paquets = new Map<string, { agent: string; rowKeys: string[] }>();
  for (const ligne of lignes) {
    rows.push({
      key: ligne.key,
      sessionId: ligne.sessionId,
      depth: ligne.depth,
      role: ligne.role,
      state: ligne.state,
      start: ligne.start,
      end: ligne.end,
      calls: ligne.calls.map((call) => mergeCall(call, ligne.sessionId, byMessage.get(call.messageId))),
      ticks: rowTicks(ligne, bySession),
      groupe: null,
    });
    const trait = traits.get(ligne.key);
    if (ligne.role !== "delegation" || !trait?.agent) continue;
    const key = `groupe:${trait.parentId ?? state.rootId}:${trait.agent}`;
    const paquet = paquets.get(key) ?? { agent: trait.agent, rowKeys: [] };
    paquet.rowKeys.push(ligne.key);
    paquets.set(key, paquet);
  }
  const groupes: ChronologieGroup[] = [];
  const parLigne = new Map<string, string>();
  for (const [key, paquet] of paquets) {
    if (paquet.rowKeys.length < GROUPE_MIN) continue;
    groupes.push({ key, agent: paquet.agent, count: paquet.rowKeys.length, rowKeys: [...paquet.rowKeys] });
    for (const rowKey of paquet.rowKeys) parLigne.set(rowKey, key);
  }
  let start: number | null = null;
  let end: number | null = null;
  let ouvert = false;
  for (const row of rows) {
    row.groupe = parLigne.get(row.key) ?? null;
    if (!CLOS.has(row.state)) ouvert = true;
    const debuts = [row.start, ...row.calls.map((call) => call.start), ...row.ticks.map((tick) => tick.at)];
    const fins = [row.end, ...row.calls.map((call) => call.end), ...row.ticks.map((tick) => tick.at)];
    for (const at of debuts) if (at !== null) start = start === null ? at : Math.min(start, at);
    for (const at of fins) if (at !== null) end = end === null ? at : Math.max(end, at);
  }
  const curseur = ouvert && now !== null ? now : null;
  if (curseur !== null) end = end === null ? curseur : Math.max(end, curseur);
  return { start, end, curseur, rows, groupes, partiel: activityStatus(state).partial };
}
