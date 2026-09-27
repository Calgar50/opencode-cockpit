// Propriétaire : L44d.
// Carte d'une méthode dans la bibliothèque (itération 5, plan d'exécution it5 fiche L44d ; conception C §9.8 ; recherche RM §5.6 ;
// spécification §5.5, §5.6) : titre, « Aucun appel d'IA en plus », phrase, « Quand », « Attention », « Utilisée par »,
// [Texte exact] replié, [Ajouter à un assistant] (menu APG) et, en mode Avancé seulement, les sources.
//
// Tout le texte affiché vient de la réponse HTTP (catalogue des méthodes, titres d'assistants lus dans des fichiers) : il est
// rendu comme enfant React, donc ÉCHAPPÉ ; aucun `dangerouslySetInnerHTML`, aucun Markdown. Le seul endroit où une chaîne
// devient une adresse est `sourceHref`, qui n'accepte que « https:// ».
//
// Aucun texte n'est écrit ici : les phrases viennent de construction-texts.ts (T5a) et les gabarits sont remplis par
// shared/methods-view.ts. Aucune limite n'est recopiée : elle arrive avec le catalogue (GET /api/methods).
// Clavier : APG « Menu Button » et « Menu », par les fonctions pures de shared/autonomy-menu.ts (aucun raccourci global).
import { type KeyboardEvent, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { buttonKey, menuKey, openingIndex } from "../../../../server/shared/autonomy-menu.ts";
import { TEXTES } from "../../../../server/shared/construction-texts.ts";
import {
  methodAttachable,
  methodMenuState,
  type MethodViewLimits,
  sourceHref,
  texteAttention,
  texteQuand,
  texteUtiliseePar,
} from "../../../../server/shared/methods-view.ts";
import { Icon } from "../../../components/Icon.tsx";
import { Badge, Button } from "../../../components/ui.tsx";
import type { AssistantView, MethodView } from "../../../lib/types.ts";

const M = TEXTES.partout.methodes;

/** Phrase de la méthode « Seconde lecture » : elle ne s'attache pas, elle se demande depuis le chat (C §9.7). */
const RENVOI_CHAT = "Elle se demande depuis le chat, sous une réponse terminée : bouton « Seconde lecture ».";

export interface MethodCardProps {
  method: MethodView;
  limites: MethodViewLimits;
  /** Assistants du cockpit ; null tant qu'ils ne sont pas lus (le menu annonce alors qu'il n'a rien à proposer). */
  assistants: readonly AssistantView[] | null;
  /** Un ajout est en cours dans la bibliothèque : tous les menus sont inertes le temps de la réponse. */
  busy: boolean;
  onAjouter: (assistant: AssistantView, method: MethodView) => void;
  avance: boolean;
}

export function MethodCard({ method, limites, assistants, busy, onAjouter, avance }: MethodCardProps) {
  const titreId = useId();
  const utilisee = texteUtiliseePar(method.utiliseePar);
  const attachable = methodAttachable(method);
  return (
    <article className="met-card" aria-labelledby={titreId}>
      <div className="met-card-head">
        <h3 id={titreId} className="spacer">
          {method.titre}
        </h3>
        <Badge tone="good">
          <Icon name="check" size={12} />
          {M.carte.sansAppel}
        </Badge>
      </div>
      <p className="met-phrase">{method.phrase}</p>
      <p className="small secondary">{texteQuand(method)}</p>
      <p className="small secondary met-attention">
        <Icon name="alert" size={14} />
        <span>{texteAttention(method)}</span>
      </p>
      {utilisee ? <p className="small met-utilisee">{utilisee}</p> : null}
      {attachable ? (
        <details className="met-details">
          <summary>{M.carte.texteExact}</summary>
          <pre className="met-bloc">{method.bloc}</pre>
        </details>
      ) : (
        <p className="small secondary">{RENVOI_CHAT}</p>
      )}
      {avance && method.sources.length > 0 ? (
        <details className="met-details">
          <summary>{TEXTES.avance.methodes.sources}</summary>
          <ul className="met-sources">
            {method.sources.map((source) => {
              const href = sourceHref(source);
              return (
                <li key={source}>
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer noopener">
                      {source}
                    </a>
                  ) : (
                    <span className="mono">{source}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
      {attachable ? (
        <div className="met-card-actions">
          <AddToAssistantMenu method={method} limites={limites} assistants={assistants} busy={busy} onAjouter={onAjouter} />
        </div>
      ) : null}
    </article>
  );
}

/**
 * Menu « Ajouter à un assistant » (APG) : un `menuitem` par assistant du cockpit. Une entrée indisponible reste focalisable et
 * porte SA raison (« Déjà appliquée par l'assistant. », « 2 méthodes au maximum … »), jamais une couleur seule : un cadenas
 * accompagne toujours la phrase.
 */
function AddToAssistantMenu({
  method,
  limites,
  assistants,
  busy,
  onAjouter,
}: Pick<MethodCardProps, "method" | "limites" | "assistants" | "busy" | "onAjouter">) {
  const baseId = useId();
  const menuId = `${baseId}-menu`;
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);

  const items = (assistants ?? []).map((assistant) => ({
    assistant,
    etat: methodMenuState({ name: assistant.name, title: assistant.title, methods: assistant.methods }, method, limites),
  }));

  const closeMenu = useCallback(() => {
    setOpen(false);
    setFocused(-1);
    buttonRef.current?.focus();
  }, []);

  const openMenu = (index: number | null) => {
    setOpen(true);
    setFocused(index ?? -1);
  };

  useLayoutEffect(() => {
    if (open && focused >= 0) itemRefs.current[focused]?.focus();
  }, [open, focused]);

  // Menu ouvert : un clic hors du menu le ferme. Aucun écouteur de touches hors du bouton et du menu (spécification §5.5).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setFocused(-1);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const activate = (index: number) => {
    const item = items[index];
    if (!item || !item.etat.active || busy) return;
    closeMenu();
    onAjouter(item.assistant, method);
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const effect = menuKey(
      items.map((item) => item.assistant.title),
      focused,
      event.key,
    );
    if (effect.kind === "none") return;
    if (effect.kind === "close") {
      if (!effect.keepDefault) event.preventDefault();
      closeMenu();
      return;
    }
    event.preventDefault();
    if (effect.kind === "focus") setFocused(effect.index);
    else activate(effect.index);
  };

  return (
    <div
      ref={wrapperRef}
      className="met-menu-wrap"
      onBlur={(event) => {
        if (open && !wrapperRef.current?.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
          setFocused(-1);
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="btn sm met-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`${M.carte.ajouterAssistant} : ${method.titre}`}
        disabled={busy}
        onClick={() => (open ? closeMenu() : openMenu(openingIndex(items.length)))}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          const index = buttonKey(event.key, items.length);
          if (index === null) return;
          event.preventDefault();
          openMenu(index);
        }}
      >
        <Icon name="plus" size={14} />
        <span>{M.carte.ajouterAssistant}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open ? (
        <div id={menuId} role="menu" tabIndex={-1} aria-label={M.carte.ajouterAssistant} className="met-menu" onKeyDown={onMenuKeyDown}>
          {items.length === 0 ? (
            <p className="small muted met-menu-vide">Aucun assistant installé.</p>
          ) : (
            items.map((item, index) => (
              <div
                key={item.assistant.name}
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                role="menuitem"
                tabIndex={-1}
                className="met-menu-item"
                aria-disabled={!item.etat.active || undefined}
                aria-labelledby={`${baseId}-${index}-titre`}
                aria-describedby={item.etat.raison ? `${baseId}-${index}-raison` : undefined}
                aria-posinset={index + 1}
                aria-setsize={items.length}
                onClick={() => activate(index)}
                onFocus={() => setFocused(index)}
              >
                <span className="met-menu-text">
                  <span id={`${baseId}-${index}-titre`} className="met-menu-label">
                    {item.assistant.title}
                  </span>
                  {item.etat.raison ? (
                    <span id={`${baseId}-${index}-raison`} className="met-menu-reason">
                      <Icon name="lock" size={12} />
                      {item.etat.raison}
                    </span>
                  ) : null}
                </span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Bouton [Ajouter] d'une méthode conseillée : même règle que le menu, la raison à côté du bouton désactivé. */
export function SuggestionButton({
  libelle,
  raison,
  busy,
  onAjouter,
}: {
  libelle: string;
  raison: string | null;
  busy: boolean;
  onAjouter: () => void;
}) {
  return (
    <span className="met-suggestion">
      <span className="met-suggestion-titre">{libelle}</span>
      {raison ? (
        <span className="met-menu-reason">
          <Icon name="lock" size={12} />
          {raison}
        </span>
      ) : (
        <Button size="sm" icon="plus" disabled={busy} onClick={onAjouter}>
          {M.carte.ajouter}
        </Button>
      )}
    </span>
  );
}
