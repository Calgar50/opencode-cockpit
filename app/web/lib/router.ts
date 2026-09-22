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
  // --- équipes (it4) : début ---
  | { mode: "equipes" }
  | { mode: "equipe-nouvelle" }
  | { mode: "equipe-modifier"; id: string }
  | { mode: "carte"; element: string | null }
  // --- équipes (it4) : fin ---
  // <c5:onglet-methodes>
  /** Itération 5 (L44f) : onglet « Méthodes » (#/assistants/methodes), qui accueille la bibliothèque des méthodes de L44d. */
  | { mode: "methodes" }
  // </c5:onglet-methodes>
  | { mode: "liste" }
  | { mode: "nouveau" }
  | { mode: "modifier" | "completer" | "detail"; name: string };

const LIST_VIEW: AssistantsView = Object.freeze({ mode: "liste" });

/** #/assistants, #/assistants/nouveau, #/assistants/modifier/<nom>, #/assistants/completer/<nom>, #/assistants/detail/<nom>. */
export function assistantsHref(view: AssistantsView = LIST_VIEW): string {
  // --- équipes (it4) : début ---
  // #/assistants/equipes, #/assistants/equipes/nouvelle, #/assistants/equipes/modifier/<id>,
  // #/assistants/carte?element=<id de nœud>.
  if (view.mode === "equipes") return routeHref("assistants", "equipes");
  if (view.mode === "equipe-nouvelle") return routeHref("assistants", "equipes", "nouvelle");
  if (view.mode === "equipe-modifier") return routeHref("assistants", "equipes", "modifier", view.id);
  if (view.mode === "carte") {
    const query = view.element ? `?${new URLSearchParams({ [CARTE_ELEMENT_PARAM]: view.element }).toString()}` : "";
    return `${routeHref("assistants", "carte")}${query}`;
  }
  // --- équipes (it4) : fin ---
  // <c5:onglet-methodes-href>
  if (view.mode === "methodes") return routeHref("assistants", "methodes");
  // </c5:onglet-methodes-href>
  if (view.mode === "liste") return routeHref("assistants");
  if (view.mode === "nouveau") return routeHref("assistants", "nouveau");
  return routeHref("assistants", view.mode, view.name);
}

export function openAssistants(view: AssistantsView = LIST_VIEW): void {
  goTo(assistantsHref(view));
}

// --- équipes (it4) : début ---
/** Identifiant d'une équipe lu dans l'adresse (…/equipes/modifier/<id>) ; toute autre valeur donne la vue par défaut. */
const ASSISTANTS_ROUTE_ID = /^[a-z0-9-]{1,40}$/;

/**
 * Élément de la carte lu dans l'adresse : identifiant de nœud (C §9.8, mapNodeId de server/shared/agent-map.ts), jamais un nom
 * seul (un agent, un raccourci et une fiche peuvent porter le même). « vous » ; `agent:`, `raccourci:` ou `fiche:` suivi d'un nom
 * conforme à la règle des noms d'opencode de la 1.1 (fact-store.ts, task-once-guard.ts : 64 caractères au plus) ; `equipe:` suivi
 * d'un identifiant d'équipe. Toute autre valeur donne la vue par défaut.
 */
const CARTE_ELEMENT_ID = /^(?:vous|(?:agent|raccourci|fiche):[A-Za-z0-9][A-Za-z0-9_.-]{0,63}|equipe:[a-z0-9-]{1,40})$/;

/** Paramètre de la carte qui choisit l'élément montré : #/assistants/carte?element=<id de nœud> (agent:relire-script, vous…). */
export const CARTE_ELEMENT_PARAM = "element";

/** Onglets de la page Assistants, dans l'ordre affiché. La création et la modification (assistant, équipe) n'en ont pas. */
// 5b (L44f) : « Méthodes » ajouté EN FIN de liste ; l'ordre des trois onglets de l'itération 4, relu et capturé par son banc,
// ne bouge pas.
export const ASSISTANTS_TABS = ["assistants", "equipes", "carte", "methodes"] as const;
export type AssistantsTab = (typeof ASSISTANTS_TABS)[number];

/** Onglet actif d'une vue ; null : vue en pleine page, sans onglets (assistant de création, éditeur d'équipe). */
export function assistantsTabOf(view: AssistantsView): AssistantsTab | null {
  if (view.mode === "liste" || view.mode === "detail") return "assistants";
  if (view.mode === "equipes" || view.mode === "carte" || view.mode === "methodes") return view.mode;
  return null;
}

/** Adresse d'un onglet : #/assistants, #/assistants/equipes, #/assistants/carte, #/assistants/methodes. */
export function assistantsTabHref(tab: AssistantsTab): string {
  if (tab === "equipes") return assistantsHref({ mode: "equipes" });
  if (tab === "carte") return assistantsHref({ mode: "carte", element: null });
  // <c5:onglet-methodes-tab>
  if (tab === "methodes") return assistantsHref({ mode: "methodes" });
  // </c5:onglet-methodes-tab>
  return assistantsHref(LIST_VIEW);
}

/** Élément de la carte lu dans l'adresse : null s'il est absent ou vide ; undefined s'il est invalide, trop long ou répété. */
function carteElementOf(query: URLSearchParams): string | null | undefined {
  const elements = query.getAll(CARTE_ELEMENT_PARAM);
  if (elements.length > 1) return undefined;
  const element = elements[0];
  if (element === undefined || element === "") return null;
  return CARTE_ELEMENT_ID.test(element) ? element : undefined;
}

/**
 * Vues des équipes et de la carte (segments « equipes » et « carte »), identifiants validés ; null : autre adresse, lue ensuite
 * comme avant. Segment en trop, identifiant absent, invalide ou trop long, élément répété : vue par défaut (liste).
 */
function teamsViewOf(route: readonly string[], query: URLSearchParams): AssistantsView | null {
  const [section, sub, third, id, ...rest] = route;
  if (section !== "assistants" || (sub !== "equipes" && sub !== "carte")) return null;
  if (sub === "carte") {
    const element = third === undefined ? carteElementOf(query) : undefined;
    return element === undefined ? LIST_VIEW : { mode: "carte", element };
  }
  if (third === undefined) return { mode: "equipes" };
  if (third === "nouvelle" && id === undefined) return { mode: "equipe-nouvelle" };
  if (third === "modifier" && id !== undefined && rest.length === 0 && ASSISTANTS_ROUTE_ID.test(id)) return { mode: "equipe-modifier", id };
  return LIST_VIEW;
}

// --- équipes (it4) : fin ---
/** Lit la vue de la page Assistants depuis la route (segments après « assistants »). */
// --- équipes (it4) : début ---
// Paramètres de l'adresse en plus (élément de la carte) ; vues des équipes et de la carte lues en premier.
export function assistantsViewOf(route: readonly string[], query: URLSearchParams = new URLSearchParams()): AssistantsView {
  const equipes = teamsViewOf(route, query);
  if (equipes) return equipes;
  // --- équipes (it4) : fin ---
  const [section, sub, name] = route;
  if (section !== "assistants") return LIST_VIEW;
  // <c5:onglet-methodes-route>
  // #/assistants/methodes (L44f). Un segment en trop donne la vue par défaut, comme pour les vues des équipes : une adresse
  // partagée ne devine jamais ce qu'elle ne reconnaît pas.
  if (sub === "methodes") return route.length === 2 ? { mode: "methodes" } : LIST_VIEW;
  // </c5:onglet-methodes-route>
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
