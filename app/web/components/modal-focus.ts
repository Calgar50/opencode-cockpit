// Piège à focus des boîtes de dialogue (correction du défaut D6 du banc de la vague 4 de l'itération 4, arbitrage A13).
// Fichier NEUF de la branche « équipes (it4) » ; `components/ui.tsx`, qui est partagé, ne fait que l'appeler, entre ses balises.
//
// Pourquoi un module à part, et non quelques lignes de plus dans `ui.tsx` : le correctif change le clavier de TOUTES les boîtes
// de dialogue de l'application, il lui faut donc un test qui l'éprouve vraiment. Or `npm test` lance Node sur des `.ts`
// (effacement de types) : un `.tsx` ne s'y importe pas, faute de moteur JSX, et aucune dépendance ne peut être ajoutée (P8).
// Écrit ici, le piège est monté tel quel par `croisements-eq-v4.test.ts`, avec un DOM minimal : c'est bien ce code-là qui est
// éprouvé, pas une copie.
//
// Ce que le piège fait, et rien de plus (spécification §5.5, motif APG « Dialog (Modal) ») : `aria-modal="true"` promet que le
// focus reste DANS la boîte ; seules les deux EXTRÉMITÉS bouclent. L'ordre de tabulation à l'intérieur ne change pas, Échap et
// le retour du focus à l'élément qui a ouvert la boîte restent ceux de l'itération 1, dans `ui.tsx`.

/** Éléments qui peuvent recevoir le focus par tabulation dans une boîte de dialogue (ordre du document). */
export const FOCUSABLES =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled]), summary, audio[controls], video[controls]';

/** Ce que le piège demande d'une touche : de quoi décider, et de quoi retenir la tabulation. */
export interface ToucheTabulation {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  preventDefault: () => void;
}

/**
 * Retient la tabulation dans `boite`, si et seulement si `fond` est la boîte du dessus de la pile (`.modal-backdrop`) — comme
 * Échap, qui ne ferme que celle-là. Une touche autre que Tab, ou accompagnée d'Alt, Ctrl ou Cmd, n'est jamais touchée.
 *
 * `doc` est le document, passé pour que le test le fournisse ; en production, `ui.tsx` ne le passe pas.
 */
export function piegerLaTabulation(e: ToucheTabulation, boite: HTMLElement | null, fond: Element | null, doc: Document = document): void {
  if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
  const pile = doc.querySelectorAll(".modal-backdrop");
  if (pile[pile.length - 1] !== fond) return;
  if (!boite) return;
  const cibles = [...boite.querySelectorAll<HTMLElement>(FOCUSABLES)].filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true" && (el.offsetWidth > 0 || el.offsetHeight > 0 || el === doc.activeElement),
  );
  if (cibles.length === 0) {
    // Boîte sans rien à focaliser : le focus se pose sur elle (elle porte tabIndex={-1}), jamais derrière.
    e.preventDefault();
    boite.focus();
    return;
  }
  const premier = cibles[0] as HTMLElement;
  const dernier = cibles[cibles.length - 1] as HTMLElement;
  const actif = doc.activeElement;
  const dehors = !(actif instanceof Node) || !boite.contains(actif);
  if (e.shiftKey && (actif === premier || actif === boite || dehors)) {
    e.preventDefault();
    dernier.focus();
  } else if (!e.shiftKey && (actif === dernier || dehors)) {
    e.preventDefault();
    premier.focus();
  }
}
