// Routage minimal par fragment (#/chat/ses_x) : aucune dépendance, compatible avec le repli SPA.
// Une garde de navigation (brouillon non enregistré) peut retenir un changement de page le temps d'une confirmation.
import { useMemo, useSyncExternalStore } from "react";

/** Résout true pour quitter la page courante vers `nextHash`, false pour rester. */
export type NavigationGuard = (nextHash: string) => Promise<boolean>;

const listeners = new Set<() => void>();
let committed = "";
let attached = false;
let guard: NavigationGuard | null = null;
let asking = false;
/** Fragment accepté par la garde : le prochain hashchange vers lui passe sans nouvelle question. */
let bypass: string | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

function urlWithHash(hash: string): string {
  return `${window.location.pathname}${window.location.search}${hash}`;
}

function onHashChange(): void {
  const next = window.location.hash;
  if (next === committed) return;
  if (!guard || bypass === next) {
    bypass = null;
    committed = next;
    notify();
    return;
  }
  // Rétablit l'adresse affichée sans prévenir les abonnés (la page reste montée), puis demande confirmation.
  window.history.replaceState(window.history.state, "", urlWithHash(committed));
  if (asking) return;
  asking = true;
  const ask = guard;
  ask(next)
    .catch(() => false)
    .then((ok) => {
      asking = false;
      if (!ok) return;
      bypass = next;
      window.location.hash = next;
    });
}

function subscribe(callback: () => void): () => void {
  if (!attached) {
    attached = true;
    committed = window.location.hash;
    window.addEventListener("hashchange", onHashChange);
  }
  listeners.add(callback);
  return () => listeners.delete(callback);
}

const snapshot = () => (attached ? committed : window.location.hash);

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

/** Paramètres placés après « ? » dans le fragment (#/chat?assistant=relire-script). */
export function parseRouteQuery(hash: string): URLSearchParams {
  const index = hash.indexOf("?");
  return new URLSearchParams(index >= 0 ? hash.slice(index + 1) : "");
}

export function useRoute(): string[] {
  const hash = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => parseRoute(hash), [hash]);
}

export function useRouteQuery(): URLSearchParams {
  const hash = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => parseRouteQuery(hash), [hash]);
}

export function routeHref(...segments: Array<string | null | undefined>): string {
  return `#/${segments.filter((s): s is string => Boolean(s)).map(encodeURIComponent).join("/")}`;
}

export function navigate(...segments: Array<string | null | undefined>): void {
  goTo(routeHref(...segments));
}

/** Va vers un fragment complet (« #/… », paramètres compris). Passe par la garde de navigation. */
export function goTo(href: string): void {
  if (window.location.hash !== href) window.location.hash = href;
}

/**
 * Installe une garde de navigation (une seule active : la dernière installée). Renvoie la fonction qui la retire.
 * Pensez aussi à `beforeunload` pour la fermeture de l'onglet.
 */
export function setNavigationGuard(next: NavigationGuard): () => void {
  guard = next;
  return () => {
    if (guard === next) guard = null;
  };
}

// --- Assistants (0.2.0) : adresses partagées avec le chat -------------------------------

/** Paramètre du chat qui présélectionne un assistant : #/chat?assistant=<nom>. */
export const CHAT_ASSISTANT_PARAM = "assistant";

export type AssistantsView =
  | { mode: "liste" }
  | { mode: "nouveau" }
  | { mode: "modifier" | "completer" | "detail"; name: string };

const LIST_VIEW: AssistantsView = Object.freeze({ mode: "liste" });

/** #/assistants, #/assistants/nouveau, #/assistants/modifier/<nom>, #/assistants/completer/<nom>, #/assistants/detail/<nom>. */
export function assistantsHref(view: AssistantsView = LIST_VIEW): string {
  if (view.mode === "liste") return routeHref("assistants");
  if (view.mode === "nouveau") return routeHref("assistants", "nouveau");
  return routeHref("assistants", view.mode, view.name);
}

export function openAssistants(view: AssistantsView = LIST_VIEW): void {
  goTo(assistantsHref(view));
}

/** Lit la vue de la page Assistants depuis la route (segments après « assistants »). */
export function assistantsViewOf(route: readonly string[]): AssistantsView {
  const [section, sub, name] = route;
  if (section !== "assistants") return LIST_VIEW;
  if (sub === "nouveau") return { mode: "nouveau" };
  if ((sub === "modifier" || sub === "completer" || sub === "detail") && name) return { mode: sub, name };
  return LIST_VIEW;
}

/** #/chat?assistant=<nom> : le chat sélectionne cet assistant pour une nouvelle demande. */
export function chatWithAssistantHref(name: string): string {
  return `${routeHref("chat")}?${new URLSearchParams({ [CHAT_ASSISTANT_PARAM]: name }).toString()}`;
}

export function openChatWithAssistant(name: string): void {
  goTo(chatWithAssistantHref(name));
}
