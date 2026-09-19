// Propriétaire : L6s puis L12a.
// Sélecteur « Autonomie » : bouton de menu avant « Envoyer » (`composer`) et répété dans l'en-tête (`header`) (spécification
// §4.13, §4.9 point 1, §5.5, §5.6, P7 ; plan d'exécution, fiche L6s). Propriétés figées dans ../slots.ts. Modèle pur (éléments,
// raisons, clavier APG, placement, bornes) : server/shared/autonomy-menu.ts ; libellés, descriptions et raisons :
// server/shared/autonomy-choice-texts.ts, sans doublon ici. Itération 1 : « Demander à chaque fois » (PUT …/autonomie) et « Plan
// d'abord » (POST /api/plans, puis ouverture de la nouvelle conversation) ; les choix automatiques restent désactivés avec leur
// raison jusqu'à L12a (confirmation). Aucun raccourci global : les touches ne sont lues que sur le bouton et le menu. Aucune
// animation.
import { type KeyboardEvent, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BUDGET_CONFIRM_TITLE } from "../../../../server/shared/assistant-rules.ts";
import { TEXTES } from "../../../../server/shared/autonomy-choice-texts.ts";
import {
  activateItem,
  buildAutonomyMenu,
  buttonKey,
  horizontalShift,
  intersectArea,
  menuKey,
  menuMaxHeight,
  menuMaxWidth,
  menuPlacement,
  openingIndex,
  type VisibleArea,
} from "../../../../server/shared/autonomy-menu.ts";
import { useApp } from "../../../app/AppContext.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { useToast } from "../../../components/Toast.tsx";
import { useConfirm } from "../../../components/ui.tsx";
import { budgetGuard, errorText } from "../../../lib/api.ts";
import { autonomyApi } from "../../../lib/api-autonomy.ts";
import { planApi } from "../../../lib/api-plans.ts";
import { cockpitEvent, useEvents } from "../../../lib/events.ts";
import type { AutonomyChoice, ConversationAutonomyView, PlanCreateResponse } from "../../../lib/types.ts";
import type { AutonomySelectorProps } from "../slots.ts";
import "./autonomy-selector.css";

/** Racine visée par un événement `autonomie.choix` (données non fiables : lues avec prudence). */
function eventRootId(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const rootId = (data as { rootId?: unknown }).rootId;
  return typeof rootId === "string" ? rootId : null;
}

/**
 * Zone où le menu est visible : la fenêtre, réduite axe par axe par chaque ancêtre qui rogne (overflow autre que visible). La
 * colonne principale du cockpit rogne à droite du rail : le menu doit tenir dans cette colonne, pas seulement dans la fenêtre.
 */
function visibleArea(menuEl: HTMLElement): VisibleArea {
  let area: VisibleArea = { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: window.innerHeight };
  for (let el = menuEl.parentElement; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    const x = style.overflowX !== "visible";
    const y = style.overflowY !== "visible";
    if (x || y) area = intersectArea(area, el.getBoundingClientRect(), { x, y });
  }
  return area;
}

export function AutonomySelector({ placement, rootId, directory, onOpenConversation, ensureConversation }: AutonomySelectorProps) {
  const { boot } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const baseId = useId();
  const menuId = `${baseId}-menu`;

  const [view, setView] = useState<ConversationAutonomyView | null>(null);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(-1);
  const [pending, setPending] = useState(false);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  /** Dernière lecture ou écriture lancée : seule sa réponse est appliquée (une réponse plus ancienne arrivée après est ignorée). */
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const menu = useMemo(() => buildAutonomyMenu({ rootId, view, boot: boot.autonomy }), [rootId, view, boot.autonomy]);
  const place = menuPlacement(placement);

  /** Relit le choix de `id` ; un échec laisse le choix inconnu (bouton « Autonomie », aucun choix coché), jamais un choix supposé. */
  const refresh = useCallback((id: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++seqRef.current;
    autonomyApi.get(id, controller.signal).then(
      (next) => {
        if (seq === seqRef.current) setView(next);
      },
      (err: unknown) => {
        if (controller.signal.aborted || seq !== seqRef.current) return;
        console.warn("autonomie : lecture du choix impossible", errorText(err));
        setView(null);
      },
    );
  }, []);

  useEffect(() => {
    setView(null);
    if (rootId !== null) refresh(rootId);
    return () => {
      seqRef.current++;
      abortRef.current?.abort();
    };
  }, [rootId, refresh]);

  // Choix changé ailleurs (autre emplacement, carte de plan, retour à « Demander » par le serveur) ou flux rétabli : relecture.
  useEvents((event) => {
    if (rootId === null) return;
    const reconnected = cockpitEvent(event, "stream.reconnected") !== null;
    if (reconnected || eventRootId(cockpitEvent(event, "autonomie.choix")?.data) === rootId) refresh(rootId);
  });

  const closeMenu = useCallback(() => {
    setOpen(false);
    setFocused(-1);
    buttonRef.current?.focus();
  }, []);

  const openMenu = (index: number | null) => {
    setOpen(true);
    setFocused(index ?? -1);
  };

  /**
   * Largeur et hauteur bornées à la zone visible (le menu défile) et décalage qui le garde à 16 px de ses bords, même à 400 px
   * où le rail occupe la gauche de la fenêtre.
   */
  const position = useCallback(() => {
    const menuEl = menuRef.current;
    const anchor = buttonRef.current?.getBoundingClientRect();
    if (!menuEl || !anchor) return;
    const area = visibleArea(menuEl);
    menuEl.style.maxWidth = `${menuMaxWidth(area)}px`;
    menuEl.style.maxHeight = `${menuMaxHeight(anchor.top, anchor.bottom, area, place.ouverture)}px`;
    menuEl.style.transform = "";
    const rect = menuEl.getBoundingClientRect();
    const dx = horizontalShift(rect.left, rect.width, area);
    menuEl.style.transform = dx === 0 ? "" : `translateX(${Math.round(dx)}px)`;
  }, [place.ouverture]);

  useLayoutEffect(() => {
    if (open) position();
  }, [open, position]);

  // Focus sur l'élément courant du menu (déplacé seulement par l'utilisateur : ouverture, flèches, lettre, survol au clic). Posé
  // APRÈS le placement : un élément focalisé hors de la zone visible ferait défiler un ancêtre qui rogne (overflow: hidden).
  useLayoutEffect(() => {
    if (open && focused >= 0) itemRefs.current[focused]?.focus();
  }, [open, focused]);

  // Menu ouvert : un clic hors du sélecteur le ferme ; la fenêtre redimensionnée le replace. Aucun écouteur de touches ici.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setFocused(-1);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", position);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", position);
    };
  }, [open, position]);

  /** PUT …/autonomie : resserrer est immédiat ; l'erreur (phrase du serveur) est affichée, puis le choix réel est relu. */
  const applyChoice = async (choix: AutonomyChoice) => {
    setPending(true);
    let target: string | null = rootId;
    try {
      target ??= await ensureConversation();
      abortRef.current?.abort();
      const seq = ++seqRef.current;
      const next = await autonomyApi.put(target, { choix });
      if (seq === seqRef.current) setView(next);
    } catch (err) {
      toast.error(TEXTES.partout.selecteur, err);
      if (target !== null && target === rootId) refresh(target);
    } finally {
      setPending(false);
    }
  };

  /**
   * POST /api/plans dans le dossier de la conversation, puis ouverture de la conversation de plan (la saisie garde son texte).
   * Depuis une conversation existante, elle est la conversation d'origine du plan (plan_source_id).
   */
  const createPlan = async (title: string) => {
    setPending(true);
    const source = rootId ?? undefined;
    try {
      let created: PlanCreateResponse;
      try {
        created = await planApi.create(directory, { source });
      } catch (err) {
        const guard = budgetGuard(err);
        if (!guard) throw err;
        const ok = await confirm({ title: guard.title || BUDGET_CONFIRM_TITLE, message: guard.message, danger: true });
        if (!ok) return;
        created = await planApi.create(directory, { confirm: true, source });
      }
      onOpenConversation(created.rootId, null);
    } catch (err) {
      toast.error(title, err);
    } finally {
      setPending(false);
    }
  };

  const activate = (index: number) => {
    const item = menu.items[index];
    if (!item || pending) return;
    const { fermer, envoi } = activateItem(item);
    if (!fermer) return;
    closeMenu();
    if (envoi === "choix") void applyChoice(item.choix);
    else if (envoi === "plan") void createPlan(item.libelle);
  };

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = buttonKey(event.key, menu.items.length);
    if (index === null) return;
    event.preventDefault();
    openMenu(index);
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const effect = menuKey(
      menu.items.map((item) => item.libelle),
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
    else activate(effect.index);
  };

  const idOf = (choix: AutonomyChoice, part: "libelle" | "description" | "raison") => `${baseId}-${choix}-${part}`;

  return (
    <div
      ref={wrapperRef}
      className={`autonomy-selector autonomy-selector-${placement}`}
      onBlur={(event) => {
        // Focus parti hors du sélecteur (tabulation, clic ailleurs) : le menu se ferme sans reprendre le focus.
        if (open && !wrapperRef.current?.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
          setFocused(-1);
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={`btn sm${placement === "composer" ? " ghost" : ""} autonomy-button`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={menu.nomAccessible}
        aria-busy={pending || undefined}
        onClick={() => (open ? closeMenu() : openMenu(openingIndex(menu.items.length)))}
        onKeyDown={onButtonKeyDown}
      >
        {menu.icone ? <Icon name={menu.icone} size={14} /> : null}
        <span className="ellipsis autonomy-button-text">{menu.bouton}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open ? (
        <div ref={menuRef} id={menuId} role="menu" tabIndex={-1} aria-label={menu.nomMenu} className="autonomy-menu" data-ouverture={place.ouverture} onKeyDown={onMenuKeyDown}>
          {menu.items.map((item, index) => (
            <div
              key={item.choix}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              role="menuitemradio"
              tabIndex={-1}
              className="autonomy-item"
              aria-checked={item.coche}
              aria-disabled={item.desactive || undefined}
              aria-labelledby={idOf(item.choix, "libelle")}
              aria-describedby={item.raison ? `${idOf(item.choix, "description")} ${idOf(item.choix, "raison")}` : idOf(item.choix, "description")}
              aria-posinset={item.position}
              aria-setsize={item.total}
              onClick={() => activate(index)}
              onFocus={() => setFocused(index)}
            >
              <Icon name={item.icone} size={16} className="autonomy-item-icon" />
              <span className="autonomy-item-text">
                <span id={idOf(item.choix, "libelle")} className="autonomy-item-label">
                  {item.libelle}
                </span>
                <span id={idOf(item.choix, "description")} className="autonomy-item-description">
                  {item.description}
                </span>
                {item.raison ? (
                  <span id={idOf(item.choix, "raison")} className="autonomy-item-reason">
                    <Icon name="lock" size={12} />
                    {item.raison}
                  </span>
                ) : null}
              </span>
              <Icon name="check" size={16} className="autonomy-item-check" />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
