// Onglets de la page Assistants : « Assistants · Équipes · Carte » (T4w ; spécification §5.5, §5.6 ; C §9.8 ; plan it4 §4.2).
// Motif « onglets » de l'APG, activation manuelle (ouvrir un onglet change d'adresse et lit d'autres données) : role="tablist" ;
// seul l'onglet actif est dans l'ordre de tabulation ; flèches gauche et droite (et Début, Fin) déplacent le focus d'un onglet à
// l'autre, en boucle ; Entrée ou Espace ouvre l'onglet. Chaque onglet annonce sa position (aria-posinset, aria-setsize). Le focus
// n'est jamais pris : seul l'onglet que l'utilisateur vient d'ouvrir le retrouve quand la vue change sous lui. L'onglet actif est
// marqué par une bordure et un texte plus gras (assistants-tabs.css), jamais par la couleur seule. Seuls textes : les libellés.
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react";
import { ASSISTANTS_TABS, type AssistantsTab, assistantsTabHref, goTo } from "../../lib/router.ts";
import "./assistants-tabs.css";

const LABELS: Readonly<Record<AssistantsTab, string>> = { assistants: "Assistants", equipes: "Équipes", carte: "Carte" };

/** Délai au-delà duquel un onglet ouvert ne reprend plus le focus (changement de vue refusé ou abandonné). */
const REFOCUS_WINDOW_MS = 2_000;

/** Onglet que l'utilisateur vient d'ouvrir : la vue suivante lui rend le focus, une seule fois, dans le délai ci-dessus. */
let reopened: { tab: AssistantsTab; at: number } | null = null;

/** Onglet atteint par une touche depuis `index` ; null : touche sans effet sur les onglets. */
function tabIndexAfterKey(key: string, index: number, count: number): number | null {
  if (key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowLeft") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

export interface AssistantsTabsProps {
  /** Onglet de la vue affichée. */
  current: AssistantsTab;
  /** Contenu de l'onglet, rendu dans le panneau. */
  children: ReactNode;
}

/** Liste des onglets et panneau de l'onglet actif. */
export function AssistantsTabs({ current, children }: AssistantsTabsProps) {
  const baseId = useId();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const tabId = (tab: AssistantsTab) => `${baseId}-onglet-${tab}`;
  const panelId = `${baseId}-panneau`;

  useEffect(() => {
    const pending = reopened;
    reopened = null;
    if (pending?.tab !== current || Date.now() - pending.at > REFOCUS_WINDOW_MS) return;
    buttons.current[ASSISTANTS_TABS.indexOf(current)]?.focus();
  }, [current]);

  const open = (tab: AssistantsTab) => {
    if (tab === current) return;
    reopened = { tab, at: Date.now() };
    goTo(assistantsTabHref(tab));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const next = tabIndexAfterKey(event.key, index, ASSISTANTS_TABS.length);
    if (next === null) return;
    event.preventDefault();
    buttons.current[next]?.focus();
  };

  return (
    <>
      <div className="ast-tabs" role="tablist" aria-label={LABELS.assistants}>
        {ASSISTANTS_TABS.map((tab, index) => {
          const selected = tab === current;
          return (
            <button
              key={tab}
              ref={(el) => {
                buttons.current[index] = el;
              }}
              id={tabId(tab)}
              type="button"
              role="tab"
              className="ast-tab"
              aria-selected={selected}
              aria-controls={selected ? panelId : undefined}
              aria-posinset={index + 1}
              aria-setsize={ASSISTANTS_TABS.length}
              tabIndex={selected ? 0 : -1}
              onClick={() => open(tab)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {LABELS[tab]}
            </button>
          );
        })}
      </div>
      <div id={panelId} className="ast-tabpanel stack loose" role="tabpanel" aria-labelledby={tabId(current)} tabIndex={0}>
        {children}
      </div>
    </>
  );
}

/** Page d'un onglet sans en-tête propre (Équipes, Carte) : titre de la page, onglets et contenu. */
export function AssistantsTabsPage({ current, children }: AssistantsTabsProps) {
  return (
    <div className="page">
      <div className="page-narrow stack loose">
        <header className="page-header" style={{ marginBottom: 0 }}>
          <h1>{LABELS.assistants}</h1>
        </header>
        <AssistantsTabs current={current}>{children}</AssistantsTabs>
      </div>
    </div>
  );
}
