// État d'une conversation affichée : messages et parties, mis à jour par le flux d'événements.
import type { OcAssistantMessage, OcMessage, OcMessageWithParts, OcPart, OcUserMessage } from "../../lib/types.ts";

export interface MessageEntry {
  info: OcMessage;
  parts: OcPart[];
}

export interface Transcript {
  byId: ReadonlyMap<string, MessageEntry>;
  order: readonly string[];
  /** Parties reçues avant leur message (rare, mais possible selon l'ordre des événements). */
  orphans: ReadonlyMap<string, OcPart[]>;
}

export const EMPTY_TRANSCRIPT: Transcript = { byId: new Map(), order: [], orphans: new Map() };

export type TranscriptAction =
  | { type: "reset"; messages: OcMessageWithParts[] }
  /** Ajoute ce qui manque sans écraser ce que le flux a déjà apporté (chargement initial). */
  | { type: "merge-missing"; messages: OcMessageWithParts[] }
  | { type: "message"; info: OcMessage }
  | { type: "message.removed"; messageID: string }
  | { type: "part"; part: OcPart }
  | { type: "part.delta"; messageID: string; partID: string; field: string; delta: string }
  | { type: "part.removed"; messageID: string; partID: string };

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function sortOrder(byId: ReadonlyMap<string, MessageEntry>): string[] {
  return [...byId.values()]
    .sort((a, b) => a.info.time.created - b.info.time.created || compareIds(a.info.id, b.info.id))
    .map((m) => m.info.id);
}

function upsertPart(parts: OcPart[], part: OcPart): OcPart[] {
  const index = parts.findIndex((p) => p.id === part.id);
  if (index >= 0) {
    const next = parts.slice();
    next[index] = part;
    return next;
  }
  return [...parts, part].sort((a, b) => compareIds(a.id, b.id));
}

export function transcriptReducer(state: Transcript, action: TranscriptAction): Transcript {
  switch (action.type) {
    case "reset": {
      const byId = new Map<string, MessageEntry>();
      for (const m of action.messages) byId.set(m.info.id, { info: m.info, parts: [...m.parts].sort((a, b) => compareIds(a.id, b.id)) });
      return { byId, order: sortOrder(byId), orphans: new Map() };
    }
    case "merge-missing": {
      const byId = new Map(state.byId);
      for (const m of action.messages) {
        const existing = byId.get(m.info.id);
        if (!existing) {
          byId.set(m.info.id, { info: m.info, parts: [...m.parts].sort((a, b) => compareIds(a.id, b.id)) });
          continue;
        }
        let parts = existing.parts;
        for (const part of m.parts) if (!parts.some((p) => p.id === part.id)) parts = upsertPart(parts, part);
        byId.set(m.info.id, { info: existing.info, parts });
      }
      return { byId, order: sortOrder(byId), orphans: state.orphans };
    }
    case "message": {
      const byId = new Map(state.byId);
      const existing = byId.get(action.info.id);
      let parts = existing?.parts ?? [];
      const orphans = new Map(state.orphans);
      const pending = orphans.get(action.info.id);
      if (pending) {
        for (const part of pending) parts = upsertPart(parts, part);
        orphans.delete(action.info.id);
      }
      byId.set(action.info.id, { info: action.info, parts });
      return { byId, order: existing ? state.order : sortOrder(byId), orphans };
    }
    case "message.removed": {
      if (!state.byId.has(action.messageID)) return state;
      const byId = new Map(state.byId);
      byId.delete(action.messageID);
      return { ...state, byId, order: state.order.filter((id) => id !== action.messageID) };
    }
    case "part": {
      const entry = state.byId.get(action.part.messageID);
      if (!entry) {
        const orphans = new Map(state.orphans);
        orphans.set(action.part.messageID, upsertPart(orphans.get(action.part.messageID) ?? [], action.part));
        return { ...state, orphans };
      }
      const byId = new Map(state.byId);
      byId.set(entry.info.id, { info: entry.info, parts: upsertPart(entry.parts, action.part) });
      return { ...state, byId };
    }
    case "part.delta": {
      const entry = state.byId.get(action.messageID);
      if (!entry) return state;
      const index = entry.parts.findIndex((p) => p.id === action.partID);
      let parts: OcPart[];
      if (index < 0) {
        if (action.field !== "text") return state;
        parts = upsertPart(entry.parts, {
          id: action.partID,
          messageID: action.messageID,
          sessionID: entry.info.sessionID,
          type: "text",
          text: action.delta,
        });
      } else {
        const part = entry.parts[index] as unknown as Record<string, unknown>;
        const current = part[action.field];
        if (current !== undefined && typeof current !== "string") return state;
        parts = entry.parts.slice();
        parts[index] = { ...part, [action.field]: `${(current as string | undefined) ?? ""}${action.delta}` } as unknown as OcPart;
      }
      const byId = new Map(state.byId);
      byId.set(entry.info.id, { info: entry.info, parts });
      return { ...state, byId };
    }
    case "part.removed": {
      const entry = state.byId.get(action.messageID);
      if (!entry) return state;
      const byId = new Map(state.byId);
      byId.set(entry.info.id, { info: entry.info, parts: entry.parts.filter((p) => p.id !== action.partID) });
      return { ...state, byId };
    }
  }
}

export interface Turn {
  key: string;
  user: (MessageEntry & { info: OcUserMessage }) | null;
  replies: Array<MessageEntry & { info: OcAssistantMessage }>;
}

/** Regroupe chaque demande avec toutes les étapes de réponse qui s'y rattachent. */
export function groupTurns(transcript: Transcript): Turn[] {
  const turns: Turn[] = [];
  const byUser = new Map<string, Turn>();
  for (const id of transcript.order) {
    const entry = transcript.byId.get(id);
    if (!entry) continue;
    if (entry.info.role === "user") {
      const turn: Turn = { key: id, user: entry as Turn["user"], replies: [] };
      turns.push(turn);
      byUser.set(id, turn);
    } else {
      const reply = entry as Turn["replies"][number];
      const target = byUser.get(reply.info.parentID) ?? turns.at(-1);
      if (target) target.replies.push(reply);
      else turns.push({ key: id, user: null, replies: [reply] });
    }
  }
  return turns;
}

export interface TurnTotals {
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  steps: number;
  durationMs: number | null;
  running: boolean;
}

export function turnTotals(turn: Turn): TurnTotals {
  let cost = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let running = false;
  let last = 0;
  for (const reply of turn.replies) {
    cost += reply.info.cost ?? 0;
    input += reply.info.tokens?.input ?? 0;
    output += (reply.info.tokens?.output ?? 0) + (reply.info.tokens?.reasoning ?? 0);
    cacheRead += reply.info.tokens?.cache?.read ?? 0;
    if (!reply.info.time.completed && !reply.info.error) running = true;
    last = Math.max(last, reply.info.time.completed ?? 0);
  }
  const start = turn.user?.info.time.created ?? turn.replies[0]?.info.time.created;
  return {
    cost,
    input,
    output,
    cacheRead,
    steps: turn.replies.length,
    durationMs: start && last ? last - start : null,
    running,
  };
}

/** Taille du contexte du dernier appel (tokens d'entrée, cache compris). */
export function contextTokens(transcript: Transcript): { tokens: number; modelKey: string | null } {
  for (let i = transcript.order.length - 1; i >= 0; i--) {
    const entry = transcript.byId.get(transcript.order[i] as string);
    if (entry?.info.role === "assistant" && entry.info.tokens) {
      const t = entry.info.tokens;
      const tokens = t.input + t.cache.read + t.cache.write + t.output + t.reasoning;
      if (tokens > 0) return { tokens, modelKey: `${entry.info.providerID}/${entry.info.modelID}` };
    }
  }
  return { tokens: 0, modelKey: null };
}

export function lastUserModel(transcript: Transcript): { model: string | null; agent: string | null; variant: string | null } {
  for (let i = transcript.order.length - 1; i >= 0; i--) {
    const entry = transcript.byId.get(transcript.order[i] as string);
    if (entry?.info.role === "user") {
      return {
        model: `${entry.info.model.providerID}/${entry.info.model.modelID}`,
        agent: entry.info.agent,
        variant: entry.info.model.variant ?? null,
      };
    }
  }
  return { model: null, agent: null, variant: null };
}
