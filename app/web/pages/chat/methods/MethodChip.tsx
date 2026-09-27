// Propriétaire : L44e.
// Puce « + Méthode » du composeur (spécification §5.4, §5.5 ; conception C §9.4 ; plan d'exécution it5 D-5-08, §4.3).
// Une méthode est un TEXTE, jamais un appel d'IA en plus : la puce ajoute le bloc de la méthode À LA FIN DU MESSAGE, et le
// composeur l'envoie dans `parts`, sans aucun champ `system` (D-5-08). L'aperçu est replié et MODIFIABLE : ce qui part est
// exactement ce qu'il montre.
//
// Deux morceaux, deux places dans le composeur : `MethodChip` (bouton et popover) se pose dans la barre d'outils, avant
// « Envoyer » ; `MethodChipList` (méthodes retenues et aperçu) se pose sur sa propre ligne, comme les fichiers joints. L'état
// est tenu par le composeur, qui l'envoie puis le vide.
//
// Décisions et refus (raccourci, méthode déjà dans l'assistant, 2 au plus) : server/shared/chat-methods-view.ts, sans aucune
// règle dupliquée ici. Phrases : construction-texts.ts. Clavier du popover : les aides APG de autonomy-menu.ts, déjà écrites et
// testées pour le sélecteur d'autonomie (aucune dépendance nouvelle, P8). Aucune animation.
import { type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { buttonKey, menuKey, openingIndex } from "../../../../server/shared/autonomy-menu.ts";
import { methodChipLabels, methodChipState } from "../../../../server/shared/chat-methods-view.ts";
import { TEXTES } from "../../../../server/shared/construction-texts.ts";
import { Icon } from "../../../components/Icon.tsx";
import { errorText } from "../../../lib/api.ts";
import { getMethods } from "../../../lib/api-construction.ts";
import { eventBus } from "../../../lib/events.ts";
import type { MethodView } from "../../../lib/types.ts";
import { creerMagasinCatalogue } from "./catalogue-store.ts";
import "./methods-chat.css";

/** Méthode retenue pour le message en cours d'écriture ; `texte` est le bloc, modifiable dans l'aperçu. */
export interface ChosenMethod {
  id: string;
  titre: string;
  texte: string;
}

// --- Catalogue des méthodes, lu une fois par visite du chat et partagé ---------------------------------------------------------

/**
 * Le magasin lui-même vit dans `catalogue-store.ts`, sans React ni réseau : ici, seules la lecture réelle (`getMethods`) et le
 * flux réel (`eventBus`) lui sont donnés. Le catalogue est partagé par la puce, la bulle d'un message et la présence d'une
 * méthode sous une réponse : une seule lecture pour toute la page, plutôt qu'une par tour de conversation.
 */
const MAGASIN = creerMagasinCatalogue({
  lire: getMethods,
  abonnerFlux: (ecouter) => eventBus.subscribe(ecouter),
  avertir: (message, detail) => console.warn(message, errorText(detail)),
});

/** Catalogue des méthodes, partagé par la puce, la bulle et la présence. Vide tant qu'il n'est pas lu, ou en cas d'échec. */
export function useMethodCatalogue(): MethodView[] {
  return useSyncExternalStore(MAGASIN.abonner, MAGASIN.instantane, MAGASIN.instantane);
}

// --- Bouton et popover -------------------------------------------------------------------------------------------------------

export interface MethodChipProps {
  /** Nom d'agent de l'assistant du composeur : ses méthodes déjà attachées ne se redemandent pas. */
  agent: string;
  /** Le message commence par « /… » : aucune méthode ne s'ajoute à un raccourci (C §9.4). */
  estRaccourci: boolean;
  /** Composeur désactivé (aucune IA, conversation en lecture seule…). */
  desactive: boolean;
  valeur: readonly ChosenMethod[];
  onChange: (methodes: ChosenMethod[]) => void;
}

export function MethodChip({ agent, estRaccourci, desactive, valeur, onChange }: MethodChipProps) {
  const methods = useMethodCatalogue();
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const menuId = `${useId()}-menu`;

  const choisies = useMemo(() => valeur.map((methode) => methode.id), [valeur]);
  const state = useMemo(() => methodChipState({ methods, agent, estRaccourci, choisies }), [methods, agent, estRaccourci, choisies]);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setFocused(-1);
    buttonRef.current?.focus();
  }, []);

  // Menu ouvert : un clic hors de la puce le ferme. Aucun écouteur de touches global : les touches ne sont lues que sur le
  // bouton et sur le menu (APG). Aucune animation.
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

  useEffect(() => {
    if (open && focused >= 0) itemRefs.current[focused]?.focus();
  }, [open, focused]);

  // Le message devient un raccourci, ou le composeur se désactive : le menu se ferme. Les méthodes déjà retenues restent
  // visibles et retirables — le message, lui, reste modifiable.
  useEffect(() => {
    if (estRaccourci || desactive) setOpen(false);
  }, [estRaccourci, desactive]);

  const basculer = (index: number) => {
    const ligne = state.items[index];
    if (!ligne?.active) return;
    onChange(ligne.choisie ? valeur.filter((m) => m.id !== ligne.id) : [...valeur, { id: ligne.id, titre: ligne.titre, texte: ligne.bloc }]);
  };

  const openMenu = () => {
    setOpen(true);
    setFocused(openingIndex(state.items.length) ?? -1);
  };

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = buttonKey(event.key, state.items.length);
    if (index === null) return;
    event.preventDefault();
    setOpen(true);
    setFocused(index);
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const effect = menuKey(
      state.items.map((ligne) => ligne.titre),
      focused,
      event.key,
    );
    if (effect.kind === "none") return;
    if (effect.kind === "close") {
      // Tab et Maj+Tab : le focus revient au bouton, puis la tabulation du navigateur part de lui.
      if (!effect.keepDefault) event.preventDefault();
      closeMenu();
      return;
    }
    event.preventDefault();
    if (effect.kind === "focus") setFocused(effect.index);
    else basculer(effect.index);
  };

  // Aucune méthode à proposer (catalogue vide, ou lecture en échec) : la puce ne prend aucune place.
  if (state.items.length === 0) return null;

  const puce = TEXTES.partout.methodes.puce;
  return (
    <div
      ref={wrapperRef}
      className="methodes-puce"
      onBlur={(event) => {
        // Focus parti hors de la puce (tabulation, clic ailleurs) : le menu se ferme sans reprendre le focus.
        if (open && !wrapperRef.current?.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
          setFocused(-1);
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="btn ghost sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={!state.boutonActif || desactive}
        title={state.boutonRaison ?? undefined}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={onButtonKeyDown}
      >
        <Icon name="plus" size={14} />
        <span className="ellipsis">{puce.ajouter}</span>
      </button>
      {open ? (
        <div id={menuId} role="menu" tabIndex={-1} aria-label={puce.ajouter} className="methodes-menu" onKeyDown={onMenuKeyDown}>
          {state.items.map((ligne, index) => (
            <div
              key={ligne.id}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              role="menuitemcheckbox"
              tabIndex={-1}
              className="methodes-item"
              aria-checked={ligne.choisie}
              aria-disabled={ligne.active ? undefined : true}
              aria-posinset={index + 1}
              aria-setsize={state.items.length}
              onClick={() => basculer(index)}
              onFocus={() => setFocused(index)}
            >
              <span aria-hidden="true">{ligne.choisie ? <Icon name="check" size={14} /> : null}</span>
              <span className="stack tight" style={{ minWidth: 0 }}>
                <span className="methodes-item-titre">{ligne.titre}</span>
                <span className="methodes-item-detail">{ligne.phrase}</span>
                <span className="methodes-item-detail">{ligne.quand}</span>
                {ligne.raison ? <span className="methodes-item-raison">{ligne.raison}</span> : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// --- Méthodes retenues et aperçu modifiable ------------------------------------------------------------------------------------

/**
 * Ligne des méthodes retenues, posée comme les fichiers joints : une puce « Méthode : {titre} » par méthode, avec son bouton de
 * retrait, et l'aperçu replié « Ce texte sera ajouté à la fin de votre message : ». L'aperçu est MODIFIABLE : le texte affiché
 * est celui qui partira, à l'octet.
 */
export function MethodChipList({
  valeur,
  onChange,
  raison = null,
}: {
  valeur: readonly ChosenMethod[];
  onChange: (methodes: ChosenMethod[]) => void;
  /**
   * Phrase affichée quand les méthodes retenues ne partiront PAS avec ce message : raccourci, ou message sans texte écrit.
   * Rien n'est retiré en silence — le composeur garde aussi les méthodes retenues après un tel envoi.
   */
  raison?: string | null;
}) {
  if (valeur.length === 0) return null;
  const puce = TEXTES.partout.methodes.puce;
  const apercu = puce.apercu.trim();
  return (
    <div className="methodes-choisies">
      {raison ? <p className="methodes-item-raison">{raison}</p> : null}
      {valeur.map((methode) => {
        const libelles = methodChipLabels(methode.titre);
        return (
          <span key={methode.id} className="chip">
            <Icon name="list" size={12} />
            <span className="ellipsis" style={{ maxWidth: 220 }}>
              {libelles.choisie}
            </span>
            <button
              type="button"
              className="btn ghost sm icon-only"
              aria-label={libelles.retirer}
              onClick={() => onChange(valeur.filter((m) => m.id !== methode.id))}
            >
              <Icon name="x" size={12} />
            </button>
          </span>
        );
      })}
      <details className="methodes-apercu">
        <summary>{apercu}</summary>
        {valeur.map((methode) => (
          <textarea
            key={methode.id}
            value={methode.texte}
            aria-label={`${apercu} ${methode.titre}`}
            spellCheck={false}
            onChange={(event) => onChange(valeur.map((m) => (m.id === methode.id ? { ...m, texte: event.target.value } : m)))}
          />
        ))}
      </details>
    </div>
  );
}
