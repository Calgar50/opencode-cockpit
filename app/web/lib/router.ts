// Routage minimal par fragment (#/chat/ses_x) : aucune dépendance, compatible avec le repli SPA.
import { useMemo, useSyncExternalStore } from "react";

function subscribe(callback: () => void): () => void {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

const snapshot = () => window.location.hash;

export function parseRoute(hash: string): string[] {
  return hash
    .replace(/^#\/?/, "")
    .split("?")[0]!
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

export function useRoute(): string[] {
  const hash = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => parseRoute(hash), [hash]);
}

export function routeHref(...segments: Array<string | null | undefined>): string {
  return `#/${segments.filter((s): s is string => Boolean(s)).map(encodeURIComponent).join("/")}`;
}

export function navigate(...segments: Array<string | null | undefined>): void {
  const next = routeHref(...segments);
  if (window.location.hash !== next) window.location.hash = next;
}
