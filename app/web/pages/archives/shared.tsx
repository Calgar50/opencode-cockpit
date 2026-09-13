// Archives : éléments partagés par la liste et la fiche d'une conversation.
import { useEffect, useState } from "react";
import { Badge, type Tone } from "../../components/ui.tsx";
import type { Conversation } from "../../lib/types.ts";

/** Marqueurs de surlignage des extraits de recherche (caractères 2 et 3, jamais du HTML). */
const SNIPPET_OPEN = String.fromCharCode(2);
const SNIPPET_CLOSE = String.fromCharCode(3);

export type Period = "7" | "30" | "90" | "all";

export const PERIOD_DAYS: Record<Period, number | null> = { "7": 7, "30": 30, "90": 90, all: null };

export interface ArchiveFilters {
  /** Texte saisi ; la recherche part après un court délai. */
  q: string;
  period: Period;
  project: string;
  pinned: boolean;
  category: string | null;
}

export const DEFAULT_FILTERS: ArchiveFilters = { q: "", period: "all", project: "", pinned: false, category: null };

export function hasActiveFilters(filters: ArchiveFilters): boolean {
  return (
    filters.q.trim() !== "" || filters.period !== "all" || filters.project !== "" || filters.pinned || filters.category !== null
  );
}

/** Valeur recopiée après `delayMs` sans changement (saisie de recherche). */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

interface SnippetSegment {
  text: string;
  match: boolean;
}

function stripMarkers(text: string): string {
  return text.split(SNIPPET_OPEN).join("").split(SNIPPET_CLOSE).join("");
}

/** Découpe un extrait en passages normaux et passages trouvés, sans jamais interpréter de HTML. */
export function splitSnippet(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  const push = (text: string, match: boolean) => {
    const clean = stripMarkers(text);
    if (clean) segments.push({ text: clean, match });
  };
  const parts = snippet.split(SNIPPET_OPEN);
  push(parts[0] ?? "", false);
  for (const part of parts.slice(1)) {
    const end = part.indexOf(SNIPPET_CLOSE);
    if (end === -1) {
      push(part, true);
      continue;
    }
    push(part.slice(0, end), true);
    push(part.slice(end + 1), false);
  }
  return segments;
}

export function Snippet({ text }: { text: string }) {
  return (
    <>
      {splitSnippet(text).map((segment, i) =>
        segment.match ? <mark key={i}>{segment.text}</mark> : <span key={i}>{segment.text}</span>,
      )}
    </>
  );
}

interface MethodInfo {
  short: string;
  long: string;
  tone: Tone;
}

const METHODS: Record<string, MethodInfo> = {
  llm: { short: "IA", long: "Classée par l'IA", tone: "accent" },
  heuristic: { short: "auto", long: "Classée automatiquement (mots-clés)", tone: "neutral" },
  manual: { short: "manuel", long: "Classée manuellement", tone: "good" },
};

const UNCLASSIFIED: MethodInfo = { short: "non classée", long: "Pas encore classée", tone: "neutral" };

export function classificationMethod(by: string): MethodInfo {
  return METHODS[by] ?? UNCLASSIFIED;
}

/** Confiance du classement (0 à 1) en pourcentage, ou null si inconnue. */
export function formatConfidence(confidence: number | null): string | null {
  if (confidence === null || !Number.isFinite(confidence)) return null;
  const percent = confidence <= 1 ? confidence * 100 : confidence;
  return `${Math.round(Math.max(0, Math.min(100, percent)))} %`;
}

export function ClassificationBadge({ conversation }: { conversation: Pick<Conversation, "classifiedBy" | "confidence"> }) {
  const method = classificationMethod(conversation.classifiedBy);
  const confidence = conversation.classifiedBy === "manual" ? null : formatConfidence(conversation.confidence);
  return (
    <Badge tone={method.tone} title={confidence ? `${method.long} · confiance ${confidence}` : method.long}>
      {method.short}
    </Badge>
  );
}

export function DeletedBadge() {
  return (
    <Badge tone="warning" title="La session n'existe plus dans opencode : seule l'archive subsiste.">
      supprimée d'opencode
    </Badge>
  );
}
