// Propriétaire : L6s puis L12a.
// Modèle pur du menu « Autonomie » (spécification §4.13, §4.9 point 1, §5.5, §5.6, P7 ; plan d'exécution, fiches L6s et L12a) :
// éléments `menuitemradio` (choix coché, position annoncée), choix indisponibles désactivés avec leur raison, « Plan d'abord
// (nouvelle conversation) », déplacements au clavier selon l'APG (bouton de menu et menu), placement du menu selon l'emplacement
// (saisie ou en-tête) et bornes à 16 px des bords de la zone visible. Aucun texte ici : libellés, descriptions et raisons
// viennent de autonomy-choice-texts.ts (L6a), sans doublon. Aucun raccourci global : les touches ne sont lues que sur le bouton
// ou le menu focalisés. Testé par autonomy-menu.test.ts.
import { descriptionChoix, libelleChoix, raisonIndisponible, TEXTES } from "./autonomy-choice-texts.ts";
import type { ActivationRefusalCode, AutonomyChoice, BootstrapAutonomy, ConversationAutonomyView } from "./autonomy-types.ts";

/** Ordre des choix dans le menu (§2.1, §4.1). */
export const MENU_ORDER: readonly AutonomyChoice[] = ["demander", "modifications", "plan", "autonome"];

/**
 * Choix que ce sélecteur sait appliquer. Itération 1 (L6s) : « Demander à chaque fois » (PUT …/autonomie) et « Plan d'abord »
 * (POST /api/plans). Les choix automatiques demandent la confirmation de L12a : d'ici là ils restent désactivés, avec la raison
 * « a-venir ».
 */
export const SELECTOR_CHOICES: readonly AutonomyChoice[] = ["demander", "plan"];

/** Icône de chaque choix (noms de web/components/Icon.tsx) : l'icône accompagne toujours le texte, jamais seule. */
export type MenuIcon = "question" | "edit" | "list" | "shield";

export const CHOICE_ICONS: Readonly<Record<AutonomyChoice, MenuIcon>> = {
  demander: "question",
  modifications: "edit",
  plan: "list",
  autonome: "shield",
};

/**
 * Effet de l'activation d'un élément utilisable : `aucune` (choix en vigueur : le menu se ferme, rien n'est envoyé), `choix`
 * (PUT …/autonomie), `plan` (POST /api/plans, puis ouverture de la nouvelle conversation).
 */
export type MenuAction = "aucune" | "choix" | "plan";

export interface AutonomyMenuItem {
  choix: AutonomyChoice;
  libelle: string;
  description: string;
  icone: MenuIcon;
  /** aria-checked. */
  coche: boolean;
  /** aria-disabled : l'élément reste focalisable (APG) pour que sa raison soit lue ; il ne s'active pas. */
  desactive: boolean;
  /** Code de la raison d'un élément désactivé ; null : utilisable, ou raison inconnue (phrase générique). */
  raisonCode: ActivationRefusalCode | null;
  /** Phrase de la raison (autonomy-choice-texts.ts) ; null si l'élément est utilisable. */
  raison: string | null;
  action: MenuAction;
  /** aria-posinset (à partir de 1) et aria-setsize. */
  position: number;
  total: number;
}

export interface AutonomyMenuInput {
  /** null : nouvelle conversation, pas encore créée. */
  rootId: string | null;
  /**
   * Vue du serveur (GET …/autonomie) ; null tant qu'elle n'est pas lue (chargement, échec) et pour une nouvelle conversation. Une
   * vue d'une autre conversation (réponse arrivée après un changement de conversation) est ignorée.
   */
  view: ConversationAutonomyView | null;
  /** Partie `autonomy` de /api/bootstrap ; absente : interrupteur ouvert, activation fermée (porte I1). */
  boot?: BootstrapAutonomy | undefined;
  /** Choix que le sélecteur sait appliquer (défaut : SELECTOR_CHOICES). */
  utilisables?: readonly AutonomyChoice[] | undefined;
}

export interface AutonomyMenu {
  items: AutonomyMenuItem[];
  /** Choix en vigueur ; null s'il n'est pas connu (vue d'une conversation existante pas encore lue). */
  courant: AutonomyChoice | null;
  /** Texte du bouton : libellé du choix en vigueur, sinon le nom du sélecteur. */
  bouton: string;
  /** Nom accessible du bouton : « Autonomie : {libellé} », ou « Autonomie » si le choix n'est pas connu. */
  nomAccessible: string;
  /** Nom accessible du menu. */
  nomMenu: string;
  /** Icône du choix en vigueur ; null s'il n'est pas connu. */
  icone: MenuIcon | null;
}

const AUTOMATIC: ReadonlySet<AutonomyChoice> = new Set<AutonomyChoice>(["modifications", "autonome"]);

type Refusal = { code: ActivationRefusalCode | null } | null;

/** Refus du serveur pour `choix` (null : disponible). Pour « plan », « nouvelle-conversation » n'est pas un refus : c'est le chemin. */
function serverRefusal(choix: AutonomyChoice, view: ConversationAutonomyView | null, boot: BootstrapAutonomy | undefined): Refusal {
  if (view === null) {
    if (!AUTOMATIC.has(choix)) return null;
    return { code: boot?.interrupteur === false ? "autonomie-coupee" : "a-venir" };
  }
  const entry = view.disponibles.find((d) => d.choix === choix);
  // Choix absent de la réponse : indisponible, raison inconnue (phrase générique).
  if (!entry) return { code: null };
  if (choix === "plan" && entry.raison === "nouvelle-conversation") return null;
  return entry.disponible ? null : { code: entry.raison };
}

function actionOf(choix: AutonomyChoice, coche: boolean): MenuAction {
  if (coche) return "aucune";
  return choix === "plan" ? "plan" : "choix";
}

/** Menu du sélecteur pour la conversation `rootId`, à partir de la vue du serveur et de l'amorçage. */
export function buildAutonomyMenu(input: AutonomyMenuInput): AutonomyMenu {
  const view = input.view !== null && input.rootId !== null && input.view.rootId === input.rootId ? input.view : null;
  const utilisables = input.utilisables ?? SELECTOR_CHOICES;
  const existing = input.rootId !== null;
  // Nouvelle conversation : « Demander à chaque fois », défaut du serveur (§4.1) ; conversation existante : choix lu, sinon inconnu.
  let courant: AutonomyChoice | null = existing ? null : "demander";
  if (view) courant = view.choix;
  const planRoot = courant === "plan";
  const total = MENU_ORDER.length;
  const items = MENU_ORDER.map((choix, index): AutonomyMenuItem => {
    const coche = courant === choix;
    let refusal = serverRefusal(choix, view, input.boot);
    // Choix que ce sélecteur ne sait pas encore appliquer : désactivé, raison « a-venir » ; sauf le choix en vigueur, qui reste coché
    // et actif (le garder n'envoie rien).
    if (refusal === null && !coche && !utilisables.includes(choix)) refusal = { code: "a-venir" };
    const desactive = refusal !== null;
    return {
      choix,
      // §4.9 point 1 : conversation neuve « Plan d'abord » ; conversation existante (hors conversation de plan) « … (nouvelle conversation) ».
      libelle: libelleChoix(choix, choix === "plan" && existing && !planRoot),
      description: descriptionChoix(choix),
      icone: CHOICE_ICONS[choix],
      coche,
      desactive,
      raisonCode: refusal?.code ?? null,
      raison: refusal ? raisonIndisponible(refusal.code) : null,
      action: actionOf(choix, coche),
      position: index + 1,
      total,
    };
  });
  const selecteur = TEXTES.partout.selecteur;
  const current = items.find((item) => item.coche) ?? null;
  return {
    items,
    courant,
    bouton: current ? current.libelle : selecteur,
    nomAccessible: current ? `${selecteur} : ${current.libelle}` : selecteur,
    nomMenu: selecteur,
    icone: current ? current.icone : null,
  };
}

/** Activation d'un élément (clic, Entrée, Espace) : un élément désactivé ne fait rien et le menu reste ouvert (APG). */
export function activateItem(item: AutonomyMenuItem): { fermer: boolean; envoi: "choix" | "plan" | null } {
  if (item.desactive) return { fermer: false, envoi: null };
  return { fermer: true, envoi: item.action === "aucune" ? null : item.action };
}

// --- Clavier (APG « Menu Button » et « Menu ») --------------------------------------------------------------------------------

/**
 * Touche sur le bouton de menu : indice de l'élément à focaliser à l'ouverture, ou null (touche laissée au navigateur). Flèche bas :
 * premier élément ; flèche haut : dernier. Entrée et Espace passent par le clic du bouton, qui ouvre sur le premier élément
 * (openingIndex).
 */
export function buttonKey(key: string, total: number): number | null {
  if (total <= 0) return null;
  if (key === "ArrowDown") return 0;
  if (key === "ArrowUp") return total - 1;
  return null;
}

/** Élément focalisé quand le menu s'ouvre par un clic, Entrée ou Espace : le premier (APG). */
export function openingIndex(total: number): number | null {
  return total > 0 ? 0 : null;
}

/**
 * Effet d'une touche dans le menu. `close` : le menu se ferme et le focus revient au bouton ; `keepDefault` : l'action du
 * navigateur est gardée (Tab et Maj+Tab partent alors du bouton, vers l'élément suivant ou précédent de la page).
 */
export type MenuKeyEffect =
  | { kind: "focus"; index: number }
  | { kind: "activate"; index: number }
  | { kind: "close"; keepDefault: boolean }
  | { kind: "none" };

/** Lettre sans accent ni casse, pour la recherche par première lettre. */
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("fr");

/**
 * Touche dans le menu ouvert, `focused` étant l'indice de l'élément focalisé (-1 : aucun). Flèches bas et haut : suivant et
 * précédent, en boucle ; Début et Fin : premier et dernier ; Entrée et Espace : activation ; Échap : fermeture ; Tab : fermeture,
 * la tabulation continue depuis le bouton ; une lettre : élément suivant dont le libellé commence par elle. Les éléments
 * désactivés restent atteignables (leur raison est lue). Flèches gauche et droite : rien (menu vertical, sans barre de menus).
 */
export function menuKey(labels: readonly string[], focused: number, key: string): MenuKeyEffect {
  const total = labels.length;
  if (total === 0) return key === "Escape" ? { kind: "close", keepDefault: false } : { kind: "none" };
  const from = focused >= 0 && focused < total ? focused : -1;
  switch (key) {
    case "ArrowDown":
      return { kind: "focus", index: from === -1 ? 0 : (from + 1) % total };
    case "ArrowUp":
      return { kind: "focus", index: from === -1 ? total - 1 : (from - 1 + total) % total };
    case "Home":
      return { kind: "focus", index: 0 };
    case "End":
      return { kind: "focus", index: total - 1 };
    case "Enter":
    case " ":
      return from === -1 ? { kind: "none" } : { kind: "activate", index: from };
    case "Escape":
      return { kind: "close", keepDefault: false };
    case "Tab":
      return { kind: "close", keepDefault: true };
  }
  if ([...key].length !== 1 || !/[\p{L}\p{N}]/u.test(key)) return { kind: "none" };
  const letter = fold(key);
  for (let step = 1; step <= total; step++) {
    const index = (from + step + total) % total;
    if (fold(labels[index] ?? "").startsWith(letter)) return { kind: "focus", index };
  }
  return { kind: "none" };
}

// --- Placement et bornes (§5.6 : feuilles défilantes à 400 px) ---------------------------------------------------------------

export type SelectorPlacement = "composer" | "header";

export interface MenuPlacement {
  /** « haut » : le menu s'ouvre au-dessus du bouton (saisie en bas de page) ; « bas » : en dessous (en-tête). */
  ouverture: "haut" | "bas";
  /** Bord du bouton auquel le menu s'aligne avant les bornes : ses deux emplacements sont à droite de leur barre. */
  alignement: "fin";
}

/** Placement du menu selon l'emplacement du sélecteur : avant « Envoyer » (saisie) ou dans l'en-tête. */
export function menuPlacement(placement: SelectorPlacement): MenuPlacement {
  return placement === "composer" ? { ouverture: "haut", alignement: "fin" } : { ouverture: "bas", alignement: "fin" };
}

/** Marge gardée entre le menu et les bords de la zone visible (px). */
export const MENU_GUTTER = 16;
/** Écart entre le bouton et le menu (px). */
export const MENU_GAP = 6;
/** Largeur du menu quand la place le permet (px). */
export const MENU_WIDTH = 360;
/** Largeur minimale gardée pour la feuille, même dans une zone très étroite (px). */
export const MENU_MIN_WIDTH = 200;
/** Hauteur maximale du menu quand la place le permet (px). */
export const MENU_MAX_HEIGHT = 420;
/** Hauteur minimale gardée pour la feuille, même sur un écran bas : elle défile (px). */
export const MENU_MIN_HEIGHT = 120;

/**
 * Zone où le menu est visible, en coordonnées de la fenêtre : la fenêtre, réduite par chaque ancêtre qui rogne ce qui dépasse
 * (overflow autre que visible). Dans le cockpit, la colonne principale rogne à droite du rail de navigation : à 400 px, borner
 * le menu à la seule fenêtre en cachait la colonne des icônes sous le rail.
 */
export interface VisibleArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const BOTH_AXES = { x: true, y: true } as const;

/** Intersection de deux zones ; `x` ou `y` à false : l'axe n'est pas réduit (ancêtre qui ne rogne que sur l'autre axe). */
export function intersectArea(area: VisibleArea, clip: VisibleArea, axes: { x: boolean; y: boolean } = BOTH_AXES): VisibleArea {
  return {
    left: axes.x ? Math.max(area.left, clip.left) : area.left,
    right: axes.x ? Math.min(area.right, clip.right) : area.right,
    top: axes.y ? Math.max(area.top, clip.top) : area.top,
    bottom: axes.y ? Math.min(area.bottom, clip.bottom) : area.bottom,
  };
}

const finite = (...values: number[]) => values.every(Number.isFinite);

/** Largeur maximale (px) du menu dans `area` : MENU_WIDTH, ramenée à la zone moins les deux marges, jamais sous MENU_MIN_WIDTH. */
export function menuMaxWidth(area: VisibleArea, gutter = MENU_GUTTER): number {
  if (!finite(area.left, area.right, gutter)) return MENU_WIDTH;
  return Math.max(MENU_MIN_WIDTH, Math.min(MENU_WIDTH, Math.floor(area.right - area.left - 2 * gutter)));
}

/**
 * Décalage horizontal (px) à appliquer au menu, posé à `left` (bord gauche mesuré, dans la fenêtre) sur une largeur `width`, pour
 * qu'il reste à `gutter` px des bords gauche et droit de `area`. Plus large que la place : collé à la marge de gauche.
 */
export function horizontalShift(left: number, width: number, area: Pick<VisibleArea, "left" | "right">, gutter = MENU_GUTTER): number {
  if (!finite(left, width, area.left, area.right, gutter)) return 0;
  const min = area.left + gutter;
  const max = area.right - gutter;
  if (width >= max - min || left < min) return min - left;
  const overflow = left + width - max;
  return overflow > 0 ? -overflow : 0;
}

/**
 * Hauteur maximale (px) du menu ouvert vers `ouverture`, le bouton occupant [anchorTop, anchorBottom] dans `area` : la place
 * entre le bouton et le bord de la zone, moins l'écart et la marge, bornée à [MENU_MIN_HEIGHT, MENU_MAX_HEIGHT]. Le menu défile
 * au-delà.
 */
export function menuMaxHeight(
  anchorTop: number,
  anchorBottom: number,
  area: Pick<VisibleArea, "top" | "bottom">,
  ouverture: MenuPlacement["ouverture"],
): number {
  if (!finite(anchorTop, anchorBottom, area.top, area.bottom)) return MENU_MIN_HEIGHT;
  const room = ouverture === "haut" ? anchorTop - area.top - MENU_GAP - MENU_GUTTER : area.bottom - anchorBottom - MENU_GAP - MENU_GUTTER;
  return Math.max(MENU_MIN_HEIGHT, Math.min(MENU_MAX_HEIGHT, Math.floor(room)));
}
