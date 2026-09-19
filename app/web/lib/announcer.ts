// Propriétaire : L5b.
// Annonces du lecteur d'écran (spécification §5.5, §5.7.4) : UNE région `aria-live="polite"` par page, préparée dès qu'un
// composant s'abonne aux annonces, au plus une annonce toutes les 2 s (les messages arrivés entre-temps sont dits ensemble à
// l'échéance), coupable par le réglage `ui.activityAnnouncements` (Paramètres › Affichage). Partagée par « Qui travaille ? » (L5b)
// et le bandeau d'autonomie (L12b). Seulement des transitions, jamais un texte de la conversation. Ce module n'importe aucun
// composant (.tsx) : `Announcer` se teste sous Node avec une horloge et une sortie factices (server/activity-live.test.ts).
import { useCallback, useEffect } from "react";
import { ANNOUNCE_MIN_INTERVAL_MS } from "../../server/shared/activity.ts";

/** Messages gardés en attente de l'échéance ; au-delà, les plus anciens sont oubliés (seul l'état le plus récent compte). */
export const ANNOUNCE_MAX_PENDING = 3;
/** Délai avant la première écriture dans une région qui vient d'être créée : sinon, beaucoup de lecteurs d'écran ne la disent pas. */
const FRESH_REGION_DELAY_MS = 150;

export interface AnnouncerDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Écrit le texte dans la région (navigateur : région de la page). */
  write(text: string): void;
}

export class Announcer {
  readonly #deps: AnnouncerDeps;
  #enabled = true;
  #pending: string[] = [];
  #lastAt: number | null = null;
  #timer: unknown = null;

  constructor(deps: AnnouncerDeps) {
    this.#deps = deps;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** Réglage `ui.activityAnnouncements` : coupées, les messages en attente sont oubliés et `say` ne dit plus rien. */
  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (!enabled) this.clear();
  }

  /** Annonce `text` tout de suite si la dernière annonce date d'au moins 2 s, sinon à l'échéance (textes réunis). */
  say(text: string): void {
    if (!this.#enabled) return;
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean === "") return;
    this.#pending = [...this.#pending.filter((t) => t !== clean), clean].slice(-ANNOUNCE_MAX_PENDING);
    this.#flush();
  }

  /** Oublie les messages en attente (annonces coupées, page quittée). */
  clear(): void {
    this.#pending = [];
    if (this.#timer !== null) this.#deps.clearTimer(this.#timer);
    this.#timer = null;
  }

  #flush(): void {
    if (this.#pending.length === 0 || this.#timer !== null) return;
    const now = this.#deps.now();
    const wait = this.#lastAt === null ? 0 : this.#lastAt + ANNOUNCE_MIN_INTERVAL_MS - now;
    if (wait > 0) {
      this.#timer = this.#deps.setTimer(() => {
        this.#timer = null;
        this.#flush();
      }, wait);
      return;
    }
    const text = this.#pending.join(" ");
    this.#pending = [];
    this.#lastAt = now;
    this.#deps.write(text);
  }
}

let region: HTMLElement | null = null;

/** Région unique de la page, visuellement cachée ; recréée si elle a été retirée du document. `fresh` : elle vient d'apparaître. */
function pageRegion(): { element: HTMLElement; fresh: boolean } {
  if (region?.isConnected) return { element: region, fresh: false };
  region = document.createElement("div");
  region.className = "visually-hidden";
  region.setAttribute("role", "status");
  region.setAttribute("aria-live", "polite");
  region.setAttribute("aria-atomic", "true");
  document.body.append(region);
  return { element: region, fresh: true };
}

/** Annonceur de la page (navigateur). */
export const announcer = new Announcer({
  now: () => Date.now(),
  setTimer: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  write: (text) => {
    // Un nouveau nœud (et non le même texte réécrit) : deux annonces identiques qui se suivent sont bien dites deux fois.
    const line = document.createElement("p");
    line.textContent = text;
    const { element, fresh } = pageRegion();
    if (fresh) globalThis.setTimeout(() => element.replaceChildren(line), FRESH_REGION_DELAY_MS);
    else element.replaceChildren(line);
  },
});

/**
 * `say(texte)` de l'annonceur de la page, qui suit le réglage `ui.activityAnnouncements` (passé par l'appelant, lu dans useApp) :
 * coupé, rien n'est dit et les messages en attente sont oubliés. La région est préparée dès le montage, avant la première annonce.
 */
export function useAnnouncer(enabled: boolean): (text: string) => void {
  useEffect(() => {
    announcer.setEnabled(enabled);
    if (enabled) pageRegion();
  }, [enabled]);
  return useCallback((text: string) => announcer.say(text), []);
}
