// Tests du sélecteur « Autonomie » (L6s ; spécification §4.13, §4.9 point 1, §5.5, §5.6, P7 ; plan d'exécution, fiche L6s).
// Le modèle pur (server/shared/autonomy-menu.ts) porte toute la logique : éléments `menuitemradio`, choix coché, choix
// indisponibles désactivés avec leur raison, « Plan d'abord (nouvelle conversation) », clavier APG, placement et bornes à 400 px.
// L'interface n'étant pas exécutée par `npm test`, le composant et sa feuille de style sont relus (contrat statique P7 : rôles
// ARIA, aucun raccourci global, aucun texte recopié, aucune animation).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { Cockpit11Deps } from "./contracts-11.ts";
import { neutralConversationAutonomy } from "./conversation-autonomy.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { descriptionChoix, libelleChoix, raisonIndisponible, TEXTES } from "./shared/autonomy-choice-texts.ts";
import {
  activateItem,
  type AutonomyMenu,
  type AutonomyMenuInput,
  buildAutonomyMenu,
  buttonKey,
  CHOICE_ICONS,
  horizontalShift,
  intersectArea,
  MENU_GAP,
  MENU_GUTTER,
  MENU_MAX_HEIGHT,
  MENU_MIN_HEIGHT,
  MENU_MIN_WIDTH,
  MENU_ORDER,
  MENU_WIDTH,
  menuKey,
  menuMaxHeight,
  menuMaxWidth,
  menuPlacement,
  openingIndex,
  SELECTOR_CHOICES,
  type VisibleArea,
} from "./shared/autonomy-menu.ts";
import type { AutonomyChoice, AutonomyChoiceAvailability, ConversationAutonomyView } from "./shared/autonomy-types.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(APP_DIR, rel), "utf8");
const MODEL_FILE = "server/shared/autonomy-menu.ts";
const COMPONENT_FILE = "web/pages/chat/autonomy/AutonomySelector.tsx";
const CSS_FILE = "web/pages/chat/autonomy/autonomy-selector.css";

// --- Doublures ------------------------------------------------------------------------------------------------------------------

/** Vue rendue par le port neutre de L6a (porte I1 fermée) : même forme que GET …/autonomie avant L10d. */
async function neutralView(rootId: string, autonomy = true): Promise<ConversationAutonomyView> {
  const deps = { settings: { get: () => DEFAULT_SETTINGS }, env: { autonomy } } as unknown as Cockpit11Deps;
  const view = await neutralConversationAutonomy(deps).get(rootId);
  assert.ok(view);
  return view;
}

/** Vue synthétique : `choix` en vigueur, disponibilités données (par défaut celles du port neutre). */
function viewOf(rootId: string, choix: AutonomyChoice, disponibles: AutonomyChoiceAvailability[], interrupteur = true): ConversationAutonomyView {
  const caps = DEFAULT_SETTINGS.budget.autonomie;
  return {
    rootId,
    choix,
    plafonds: {
      plafondUsd: caps.plafondUsd,
      actionsMax: caps.actionsMax,
      delegationsMax: caps.delegationsMax,
      dureeMinutes: caps.dureeMinutes,
      fichiersMax: caps.fichiersMax,
      controlesIaMax: caps.controlesIaMax,
    },
    depuis: 1,
    retourCause: null,
    planSourceId: null,
    executionDePlanId: null,
    interrupteur,
    disponibles,
    demande: null,
  };
}

const PLAN_ROOT_DISPONIBLES: AutonomyChoiceAvailability[] = MENU_ORDER.map((choix) =>
  choix === "plan" ? { choix, disponible: true, raison: null } : { choix, disponible: false, raison: "racine-de-plan" },
);

const OPEN_DISPONIBLES: AutonomyChoiceAvailability[] = [
  { choix: "demander", disponible: true, raison: null },
  { choix: "modifications", disponible: true, raison: null },
  { choix: "plan", disponible: false, raison: "nouvelle-conversation" },
  { choix: "autonome", disponible: true, raison: null },
];

/** Résumé d'un menu : [choix, coché, désactivé, code de raison, action] par élément. */
const summary = (menu: AutonomyMenu) => menu.items.map((i) => [i.choix, i.coche, i.desactive, i.raisonCode, i.action]);

const build = (input: AutonomyMenuInput) => buildAutonomyMenu(input);

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

// --- Éléments du menu -----------------------------------------------------------------------------------------------------------

describe("autonomy-menu : éléments (menuitemradio, choix coché, raisons)", () => {
  it("nouvelle conversation : « Demander à chaque fois » coché, « Plan d'abord » utilisable, choix automatiques désactivés « a-venir »", () => {
    const menu = build({ rootId: null, view: null, boot: { interrupteur: true, activationOuverte: false } });
    assert.equal(menu.courant, "demander");
    assert.deepEqual(summary(menu), [
      ["demander", true, false, null, "aucune"],
      ["modifications", false, true, "a-venir", "choix"],
      ["plan", false, false, null, "plan"],
      ["autonome", false, true, "a-venir", "choix"],
    ]);
    // §4.9 point 1 : conversation neuve → « Plan d'abord » (sans « nouvelle conversation »).
    assert.equal(menu.items[2]?.libelle, "Plan d'abord");
    assert.equal(menu.items[1]?.raison, "Pas encore disponible dans cette version du cockpit.");
    assert.equal(menu.items[0]?.raison, null);
    assert.equal(menu.bouton, "Demander à chaque fois");
    assert.equal(menu.nomAccessible, "Autonomie : Demander à chaque fois");
    assert.equal(menu.nomMenu, "Autonomie");
    assert.equal(menu.icone, "question");
    // Amorçage absent (serveur sans la partie autonomy) : même menu, jamais un choix automatique utilisable.
    assert.deepEqual(summary(build({ rootId: null, view: null })), summary(menu));
  });

  it("COCKPIT_AUTONOMY=off : choix automatiques désactivés « autonomie-coupee » ; « Demander » et « Plan d'abord » restent utilisables", () => {
    const fresh = build({ rootId: null, view: null, boot: { interrupteur: false, activationOuverte: false } });
    assert.deepEqual(summary(fresh), [
      ["demander", true, false, null, "aucune"],
      ["modifications", false, true, "autonomie-coupee", "choix"],
      ["plan", false, false, null, "plan"],
      ["autonome", false, true, "autonomie-coupee", "choix"],
    ]);
    assert.equal(fresh.items[3]?.raison, TEXTES.partout.raisons["autonomie-coupee"]);
  });

  it("conversation existante lue : choix du serveur coché ; « Plan d'abord (nouvelle conversation) » ouvre un plan (« nouvelle-conversation » n'est pas un refus)", async () => {
    const view = await neutralView("ses_a");
    const menu = build({ rootId: "ses_a", view, boot: { interrupteur: true, activationOuverte: false } });
    assert.deepEqual(summary(menu), [
      ["demander", true, false, null, "aucune"],
      ["modifications", false, true, "a-venir", "choix"],
      ["plan", false, false, null, "plan"],
      ["autonome", false, true, "a-venir", "choix"],
    ]);
    assert.equal(menu.items[2]?.libelle, "Plan d'abord (nouvelle conversation)");
    // Port neutre avec COCKPIT_AUTONOMY=off : raison du serveur.
    const off = build({ rootId: "ses_a", view: await neutralView("ses_a", false) });
    assert.deepEqual(
      off.items.map((i) => i.raisonCode),
      [null, "autonomie-coupee", null, "autonomie-coupee"],
    );
  });

  it("vue pas encore lue, ou vue d'une autre conversation : aucun choix coché, bouton « Autonomie », jamais un choix supposé", async () => {
    const pending = build({ rootId: "ses_b", view: null });
    assert.equal(pending.courant, null);
    assert.ok(pending.items.every((item) => !item.coche));
    assert.equal(pending.bouton, "Autonomie");
    assert.equal(pending.nomAccessible, "Autonomie");
    assert.equal(pending.icone, null);
    // « Demander » reste possible (resserrer est toujours permis), « Plan d'abord » ouvre une nouvelle conversation.
    assert.deepEqual(
      pending.items.map((i) => i.action),
      ["choix", "choix", "plan", "choix"],
    );
    assert.equal(pending.items[2]?.libelle, "Plan d'abord (nouvelle conversation)");
    // Réponse arrivée après un changement de conversation : ignorée, même si elle coche « plan ».
    const stale = build({ rootId: "ses_b", view: viewOf("ses_autre", "plan", PLAN_ROOT_DISPONIBLES) });
    assert.deepEqual(summary(stale), summary(pending));
    // Nouvelle conversation : une vue restée d'une conversation précédente n'est jamais lue.
    const fresh = build({ rootId: null, view: viewOf("ses_autre", "plan", PLAN_ROOT_DISPONIBLES) });
    assert.equal(fresh.courant, "demander");
    assert.equal(fresh.items[2]?.libelle, "Plan d'abord");
  });

  it("conversation de plan : « Plan d'abord » coché et gardé ; les autres désactivés avec la raison « racine-de-plan »", () => {
    const menu = build({ rootId: "ses_p", view: viewOf("ses_p", "plan", PLAN_ROOT_DISPONIBLES) });
    assert.deepEqual(summary(menu), [
      ["demander", false, true, "racine-de-plan", "choix"],
      ["modifications", false, true, "racine-de-plan", "choix"],
      ["plan", true, false, null, "aucune"],
      ["autonome", false, true, "racine-de-plan", "choix"],
    ]);
    // La conversation EST le plan : libellé sans « (nouvelle conversation) ».
    assert.equal(menu.items[2]?.libelle, "Plan d'abord");
    assert.equal(menu.bouton, "Plan d'abord");
    assert.equal(menu.items[0]?.raison, "Conversation de plan : elle garde « Plan d'abord » et ne peut rien modifier, même plus tard.");
  });

  it("choix automatique disponible au serveur : désactivé par ce sélecteur (« a-venir ») ; utilisable quand le sélecteur le sait appliquer (L12a)", () => {
    const view = viewOf("ses_c", "demander", OPEN_DISPONIBLES);
    assert.deepEqual(SELECTOR_CHOICES, ["demander", "plan"]);
    const l6s = build({ rootId: "ses_c", view, boot: { interrupteur: true, activationOuverte: true } });
    assert.deepEqual(
      l6s.items.map((i) => [i.desactive, i.raisonCode]),
      [
        [false, null],
        [true, "a-venir"],
        [false, null],
        [true, "a-venir"],
      ],
    );
    const l12a = build({ rootId: "ses_c", view, utilisables: MENU_ORDER });
    assert.deepEqual(summary(l12a), [
      ["demander", true, false, null, "aucune"],
      ["modifications", false, false, null, "choix"],
      ["plan", false, false, null, "plan"],
      ["autonome", false, false, null, "choix"],
    ]);
  });

  it("raison du serveur prioritaire sur « a-venir » ; choix absent de la réponse : désactivé, phrase générique ; raison inconnue : phrase générique", () => {
    const view = viewOf("ses_d", "demander", [
      { choix: "demander", disponible: true, raison: null },
      { choix: "modifications", disponible: false, raison: "regle-allow" },
      { choix: "plan", disponible: false, raison: "nouvelle-conversation" },
    ]);
    const menu = build({ rootId: "ses_d", view });
    assert.deepEqual(summary(menu), [
      ["demander", true, false, null, "aucune"],
      ["modifications", false, true, "regle-allow", "choix"],
      ["plan", false, false, null, "plan"],
      ["autonome", false, true, null, "choix"],
    ]);
    assert.equal(menu.items[1]?.raison, raisonIndisponible("regle-allow"));
    assert.equal(menu.items[3]?.raison, TEXTES.partout.raisons.autre);
    // « plan » refusé pour une autre raison que « nouvelle-conversation » : désactivé.
    const refused = build({ rootId: "ses_d", view: viewOf("ses_d", "demander", [{ choix: "plan", disponible: false, raison: "plancher-non-verifie" }]) });
    assert.deepEqual(refused.items[2] && [refused.items[2].desactive, refused.items[2].raisonCode], [true, "plancher-non-verifie"]);
  });

  it("choix automatique en vigueur : coché et actif s'il reste disponible (le garder n'envoie rien) ; coché et désactivé avec sa raison sinon", () => {
    const kept = build({ rootId: "ses_e", view: viewOf("ses_e", "autonome", OPEN_DISPONIBLES) });
    assert.deepEqual(kept.items[3] && [kept.items[3].coche, kept.items[3].desactive, kept.items[3].action], [true, false, "aucune"]);
    assert.equal(kept.bouton, "Autonome avec contrôle");
    assert.equal(kept.icone, "shield");
    // « Modifications » disponible mais non su par ce sélecteur, non coché : désactivé.
    assert.deepEqual(kept.items[1] && [kept.items[1].desactive, kept.items[1].raisonCode], [true, "a-venir"]);
    // « Demander » (resserrer) reste utilisable.
    assert.deepEqual(kept.items[0] && [kept.items[0].desactive, kept.items[0].action], [false, "choix"]);
    const refused = build({
      rootId: "ses_e",
      view: viewOf("ses_e", "modifications", [
        { choix: "demander", disponible: true, raison: null },
        { choix: "modifications", disponible: false, raison: "mcp-ou-extension" },
        { choix: "plan", disponible: false, raison: "nouvelle-conversation" },
        { choix: "autonome", disponible: false, raison: "mcp-ou-extension" },
      ]),
    });
    assert.deepEqual(refused.items[1] && [refused.items[1].coche, refused.items[1].desactive, refused.items[1].raisonCode], [true, true, "mcp-ou-extension"]);
  });

  it("icône + texte, ordre §4.1, position annoncée (aria-posinset, aria-setsize), textes de autonomy-choice-texts.ts, vue gelée intacte", () => {
    const view = deepFreeze(viewOf("ses_f", "demander", OPEN_DISPONIBLES));
    const menu = build({ rootId: "ses_f", view });
    assert.deepEqual(
      menu.items.map((i) => i.choix),
      ["demander", "modifications", "plan", "autonome"],
    );
    for (const [index, item] of menu.items.entries()) {
      assert.equal(item.icone, CHOICE_ICONS[item.choix]);
      assert.ok(item.libelle.length > 0 && item.description.length > 0, item.choix);
      assert.equal(item.libelle, libelleChoix(item.choix, item.choix === "plan"));
      assert.equal(item.description, descriptionChoix(item.choix));
      assert.deepEqual([item.position, item.total], [index + 1, 4]);
    }
    assert.equal(new Set(menu.items.map((i) => i.icone)).size, 4, "une icône par choix");
    assert.deepEqual(build({ rootId: "ses_f", view }), menu, "même résultat à chaque appel");
  });

  it("activation : désactivé → rien, menu ouvert ; coché → fermeture sans envoi ; « Demander » → PUT ; « Plan d'abord » → POST /api/plans", () => {
    const menu = build({ rootId: "ses_g", view: viewOf("ses_g", "demander", OPEN_DISPONIBLES) });
    const [demander, modifications, plan] = menu.items;
    assert.ok(demander && modifications && plan);
    assert.deepEqual(activateItem(modifications), { fermer: false, envoi: null });
    assert.deepEqual(activateItem(demander), { fermer: true, envoi: null });
    assert.deepEqual(activateItem(plan), { fermer: true, envoi: "plan" });
    const loading = build({ rootId: "ses_g", view: null });
    assert.deepEqual(loading.items[0] && activateItem(loading.items[0]), { fermer: true, envoi: "choix" });
    const planRoot = build({ rootId: "ses_p", view: viewOf("ses_p", "plan", PLAN_ROOT_DISPONIBLES) });
    assert.deepEqual(planRoot.items[0] && activateItem(planRoot.items[0]), { fermer: false, envoi: null });
    assert.deepEqual(planRoot.items[2] && activateItem(planRoot.items[2]), { fermer: true, envoi: null });
  });
});

// --- Clavier (APG) --------------------------------------------------------------------------------------------------------------

describe("autonomy-menu : clavier (APG « Menu Button » et « Menu »), aucun raccourci global", () => {
  const LABELS = build({ rootId: "ses_k", view: null }).items.map((i) => i.libelle);

  it("bouton : flèche bas → premier élément, flèche haut → dernier ; Entrée et Espace passent par le clic (premier élément)", () => {
    assert.equal(buttonKey("ArrowDown", 4), 0);
    assert.equal(buttonKey("ArrowUp", 4), 3);
    for (const key of ["Enter", " ", "Tab", "Escape", "a", "Shift", "ArrowLeft"]) assert.equal(buttonKey(key, 4), null, key);
    assert.equal(buttonKey("ArrowDown", 0), null);
    assert.equal(openingIndex(4), 0);
    assert.equal(openingIndex(0), null);
  });

  it("menu : flèches en boucle, Début et Fin ; éléments désactivés atteignables ; flèches gauche et droite sans effet", () => {
    assert.deepEqual(menuKey(LABELS, 0, "ArrowDown"), { kind: "focus", index: 1 });
    assert.deepEqual(menuKey(LABELS, 3, "ArrowDown"), { kind: "focus", index: 0 });
    assert.deepEqual(menuKey(LABELS, 0, "ArrowUp"), { kind: "focus", index: 3 });
    assert.deepEqual(menuKey(LABELS, 2, "ArrowUp"), { kind: "focus", index: 1 }, "« Modifications automatiques », désactivé, reste atteignable");
    assert.deepEqual(menuKey(LABELS, -1, "ArrowDown"), { kind: "focus", index: 0 });
    assert.deepEqual(menuKey(LABELS, -1, "ArrowUp"), { kind: "focus", index: 3 });
    assert.deepEqual(menuKey(LABELS, 9, "ArrowDown"), { kind: "focus", index: 0 }, "indice hors bornes : repart du début");
    assert.deepEqual(menuKey(LABELS, 2, "Home"), { kind: "focus", index: 0 });
    assert.deepEqual(menuKey(LABELS, 1, "End"), { kind: "focus", index: 3 });
    for (const key of ["ArrowLeft", "ArrowRight", "Shift", "F6", "PageDown", "-", "?"]) assert.deepEqual(menuKey(LABELS, 1, key), { kind: "none" }, key);
  });

  it("menu : Entrée et Espace activent l'élément focalisé ; Échap ferme ; Tab ferme en gardant la tabulation du navigateur", () => {
    assert.deepEqual(menuKey(LABELS, 2, "Enter"), { kind: "activate", index: 2 });
    assert.deepEqual(menuKey(LABELS, 1, " "), { kind: "activate", index: 1 });
    assert.deepEqual(menuKey(LABELS, -1, "Enter"), { kind: "none" });
    assert.deepEqual(menuKey(LABELS, 1, "Escape"), { kind: "close", keepDefault: false });
    assert.deepEqual(menuKey(LABELS, 1, "Tab"), { kind: "close", keepDefault: true });
    assert.deepEqual(menuKey([], -1, "Escape"), { kind: "close", keepDefault: false });
    assert.deepEqual(menuKey([], -1, "ArrowDown"), { kind: "none" });
  });

  it("menu : une lettre focalise l'élément suivant qui commence par elle (casse et accents ignorés, en boucle), sinon rien", () => {
    assert.deepEqual(menuKey(LABELS, 0, "p"), { kind: "focus", index: 2 });
    assert.deepEqual(menuKey(LABELS, 0, "M"), { kind: "focus", index: 1 });
    assert.deepEqual(menuKey(LABELS, 0, "a"), { kind: "focus", index: 3 });
    assert.deepEqual(menuKey(LABELS, 0, "d"), { kind: "focus", index: 0 }, "seul élément en « d » : il reste focalisé");
    assert.deepEqual(menuKey(["Écrire", "Étendre", "Lire"], 0, "e"), { kind: "focus", index: 1 });
    assert.deepEqual(menuKey(["Écrire", "Étendre", "Lire"], 1, "É"), { kind: "focus", index: 0 });
    assert.deepEqual(menuKey(LABELS, 0, "z"), { kind: "none" });
  });
});

// --- Placement et bornes --------------------------------------------------------------------------------------------------------

describe("autonomy-menu : placement (saisie, en-tête) et bornes à 400 px", () => {
  it("avant « Envoyer » le menu s'ouvre au-dessus ; dans l'en-tête, en dessous ; aligné sur la fin du bouton", () => {
    assert.deepEqual(menuPlacement("composer"), { ouverture: "haut", alignement: "fin" });
    assert.deepEqual(menuPlacement("header"), { ouverture: "bas", alignement: "fin" });
  });

  /** Fenêtre de `width` × `height` px, sans ancêtre qui rogne. */
  const windowArea = (width: number, height = 900): VisibleArea => ({ left: 0, top: 0, right: width, bottom: height });
  /** Fenêtre de 400 × 760 px dont la colonne principale (overflow: hidden) commence après un rail de 57 px. */
  const RAIL = 57;
  const column400: VisibleArea = intersectArea(windowArea(400, 760), { left: RAIL, top: 0, right: 400, bottom: 760 });

  it("zone visible : la fenêtre réduite par les ancêtres qui rognent, axe par axe", () => {
    assert.deepEqual(column400, { left: RAIL, top: 0, right: 400, bottom: 760 });
    assert.deepEqual(intersectArea(windowArea(1440), { left: -20, top: 54, right: 1500, bottom: 820 }), { left: 0, top: 54, right: 1440, bottom: 820 });
    // Ancêtre qui ne rogne qu'horizontalement (overflow-x: clip) : la hauteur n'est pas réduite, et inversement.
    assert.deepEqual(intersectArea(windowArea(400, 760), { left: RAIL, top: 100, right: 380, bottom: 700 }, { x: true, y: false }), {
      left: RAIL,
      top: 0,
      right: 380,
      bottom: 760,
    });
    assert.deepEqual(intersectArea(windowArea(400, 760), { left: RAIL, top: 100, right: 380, bottom: 700 }, { x: false, y: true }), {
      left: 0,
      top: 100,
      right: 400,
      bottom: 700,
    });
  });

  it("largeur : 360 px si la zone le permet, sinon la zone moins les deux marges (rail exclu à 400 px), jamais moins de 200 px", () => {
    assert.deepEqual([MENU_WIDTH, MENU_MIN_WIDTH, MENU_GUTTER], [360, 200, 16]);
    assert.equal(menuMaxWidth(windowArea(1440)), 360);
    assert.equal(menuMaxWidth(windowArea(400)), 360, "fenêtre de 400 px sans rail : 360 px tiennent entre les marges");
    assert.equal(menuMaxWidth(windowArea(380)), 380 - 32);
    // À 400 px, la colonne principale ne fait que 343 px : le menu de 360 px y serait rogné sous le rail.
    assert.equal(menuMaxWidth(column400), 400 - RAIL - 32);
    assert.equal(menuMaxWidth(windowArea(180)), 200);
    assert.equal(menuMaxWidth({ left: Number.NaN, top: 0, right: 400, bottom: 0 }), 360);
  });

  it("décalage horizontal : rien s'il tient ; ramené à 16 px du bord gauche ou droit de la zone ; plus large que la place : collé à gauche", () => {
    assert.equal(horizontalShift(500, 360, windowArea(1440)), 0);
    assert.equal(horizontalShift(16, 360, windowArea(400)), 0, "tient pile dans une fenêtre de 400 px sans rail");
    // En-tête à 400 px : bouton suivi de quatre icônes, menu aligné à droite du bouton qui dépasse à gauche.
    assert.equal(horizontalShift(-126, 360, windowArea(400)), 142);
    assert.equal(horizontalShift(100, 360, windowArea(400)), -76);
    assert.equal(horizontalShift(40, 360, windowArea(380)), -24);
    assert.equal(horizontalShift(30, 360, windowArea(300)), -14);
    assert.equal(horizontalShift(Number.NaN, 360, windowArea(400)), 0);
    // Colonne après le rail : le bord gauche de la zone, et non celui de la fenêtre, fixe la marge (menu à 22 px : caché sous le rail).
    assert.equal(horizontalShift(22, 311, column400), RAIL + 16 - 22);
    assert.equal(horizontalShift(16, 360, column400), RAIL + 16 - 16, "trop large pour la colonne : collé à sa marge de gauche");
    assert.equal(horizontalShift(RAIL + 16, 311, column400), 0, "tient pile dans la colonne");
    for (const [left, width, area] of [
      [-126, 360, windowArea(400)],
      [100, 360, windowArea(400)],
      [300, 368, windowArea(400)],
      [-50, 200, windowArea(1024)],
      [900, 360, windowArea(1024)],
      [22, menuMaxWidth(column400), column400],
      [200, menuMaxWidth(column400), column400],
    ] as const) {
      const shifted = left + horizontalShift(left, width, area);
      assert.ok(shifted >= area.left + MENU_GUTTER, `${left} ${width} ${area.left}`);
      assert.ok(shifted + width <= area.right - MENU_GUTTER || shifted === area.left + MENU_GUTTER, `${left} ${width} ${area.right}`);
    }
  });

  it("hauteur : la place du côté de l'ouverture dans la zone, bornée entre 120 et 420 px (le menu défile au-delà)", () => {
    assert.deepEqual([MENU_MIN_HEIGHT, MENU_MAX_HEIGHT, MENU_GAP], [120, 420, 6]);
    // Saisie en bas d'une fenêtre haute : plafond de 420 px.
    assert.equal(menuMaxHeight(900, 926, windowArea(1440, 1000), "haut"), 420);
    // Saisie à 400 px de haut : place au-dessus du bouton, moins l'écart et la marge.
    assert.equal(menuMaxHeight(300, 326, windowArea(400, 400), "haut"), 300 - 6 - 16);
    // Zone qui commence sous un bandeau (haut à 100 px) : la place se compte depuis son bord.
    assert.equal(menuMaxHeight(300, 326, { top: 100, bottom: 400 }, "haut"), 300 - 100 - 6 - 16);
    // En-tête : place en dessous du bouton, jusqu'au bas de la zone.
    assert.equal(menuMaxHeight(10, 40, windowArea(400, 400), "bas"), 400 - 40 - 6 - 16);
    assert.equal(menuMaxHeight(10, 40, { top: 0, bottom: 300 }, "bas"), 300 - 40 - 6 - 16);
    assert.equal(menuMaxHeight(10, 40, windowArea(400, 1000), "bas"), 420);
    // Très peu de place : jamais moins de 120 px, la feuille défile.
    assert.equal(menuMaxHeight(60, 86, windowArea(400, 400), "haut"), 120);
    assert.equal(menuMaxHeight(Number.NaN, 0, windowArea(400, 400), "haut"), 120);
  });
});

// --- Textes, composant et pureté ------------------------------------------------------------------------------------------------

/** Phrases des choix et des raisons (autonomy-choice-texts.ts), à ne recopier nulle part. */
function choicePhrases(): string[] {
  const out: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") out.push(value);
    else if (value && typeof value === "object") for (const inner of Object.values(value)) walk(inner);
  };
  walk(TEXTES.partout.choix);
  walk(TEXTES.partout.raisons);
  return out;
}

/** Source sans commentaires (bloc, et ligne hors « :// » et chaîne) : un nom de choix cité en commentaire n'est pas un texte affiché. */
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");

/** Chaînes entre guillemets doubles d'un source, commentaires retirés. */
function quoted(source: string): string[] {
  return [...withoutComments(source).matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((m) => m[1] ?? "");
}

describe("autonomy-menu : textes (autonomy-choice-texts.ts, sans doublon) et contrat du composant (P7)", () => {
  it("aucune phrase des choix ni des raisons recopiée dans le code du modèle, du composant ou de sa feuille de style", () => {
    const phrases = choicePhrases();
    assert.ok(phrases.length >= 10);
    for (const file of [MODEL_FILE, COMPONENT_FILE, CSS_FILE]) {
      const source = withoutComments(read(file));
      for (const phrase of phrases) assert.equal(source.includes(phrase), false, `${file} : « ${phrase} » recopié`);
    }
  });

  it("modèle : aucun texte affiché écrit en dur (chaînes = codes, touches ou séparateurs)", () => {
    for (const literal of quoted(read(MODEL_FILE))) {
      assert.doesNotMatch(literal, /\p{L}\s+\p{L}|(?=\P{ASCII})\p{L}/u, `texte affiché dans le modèle : « ${literal} »`);
    }
  });

  it("composant : aucun texte affiché écrit en dur (ni texte JSX, ni aria-label, title ou placeholder littéraux)", () => {
    const source = read(COMPONENT_FILE);
    const jsxText = [...source.matchAll(/>([^<>{}()=;]*\p{L}[^<>{}()=;]*)</gu)].map((m) => (m[1] ?? "").trim()).filter(Boolean);
    assert.deepEqual(jsxText, []);
    assert.doesNotMatch(source, /\b(?:aria-label|title|placeholder|alt)="/);
    // Seuls les textes des modules partagés sont affichés : titres des notifications et des confirmations compris.
    assert.match(source, /from "\.\.\/\.\.\/\.\.\/\.\.\/server\/shared\/autonomy-choice-texts\.ts"/);
    assert.match(source, /from "\.\.\/\.\.\/\.\.\/\.\.\/server\/shared\/autonomy-menu\.ts"/);
  });

  it("composant : bouton de menu, menu de menuitemradio, aria-checked, raisons décrites, position annoncée, aucun raccourci global", () => {
    const source = read(COMPONENT_FILE);
    for (const needle of [
      'aria-haspopup="menu"',
      "aria-expanded={open}",
      'role="menu"',
      'role="menuitemradio"',
      "aria-checked={item.coche}",
      "aria-disabled={item.desactive || undefined}",
      "aria-describedby=",
      "aria-posinset={item.position}",
      "aria-setsize={item.total}",
      "aria-label={menu.nomAccessible}",
      "aria-label={menu.nomMenu}",
      "tabIndex={-1}",
      "onKeyDown={onButtonKeyDown}",
      "onKeyDown={onMenuKeyDown}",
      "<Icon name={item.icone}",
      "{item.libelle}",
      "{item.raison}",
      'import "./autonomy-selector.css";',
    ]) {
      assert.ok(source.includes(needle), `absent : ${needle}`);
    }
    // Aucun raccourci global (surtout pas Maj+Tab) : aucune écoute de touches hors du bouton et du menu, aucun accessKey.
    assert.doesNotMatch(source, /addEventListener\(\s*["']key(?:down|up|press)["']/);
    assert.doesNotMatch(source, /\baccessKey\b|\bshiftKey\b/);
    // Actions de l'itération 1 : PUT du choix, POST /api/plans puis ouverture de la conversation (la saisie garde son texte).
    assert.match(source, /autonomyApi\.put\(/);
    assert.match(source, /planApi\.create\(directory\)/);
    assert.match(source, /onOpenConversation\(created\.rootId, null\)/);
    // Le composant ne décide rien : il lit le modèle.
    assert.match(source, /buildAutonomyMenu\(\{ rootId, view, boot: boot\.autonomy \}\)/);
  });

  it("composant : bornes du menu prises dans la zone visible (ancêtres qui rognent, rail exclu), jamais dans la seule fenêtre", () => {
    const source = withoutComments(read(COMPONENT_FILE));
    for (const needle of [
      "getComputedStyle(el)",
      'const x = style.overflowX !== "visible";',
      'const y = style.overflowY !== "visible";',
      "intersectArea(area, el.getBoundingClientRect(), { x, y })",
      "const area = visibleArea(menuEl);",
      "menuEl.style.maxWidth = `${menuMaxWidth(area)}px`;",
      "menuMaxHeight(anchor.top, anchor.bottom, area, place.ouverture)",
      "horizontalShift(rect.left, rect.width, area)",
    ]) {
      assert.ok(source.includes(needle), `absent : ${needle}`);
    }
    // Les dimensions de la fenêtre ne servent qu'à la zone de départ, avant les ancêtres.
    assert.equal(source.match(/\bwindow\.innerHeight\b|\bclientWidth\b/g)?.length, 2);
    // Placement avant le focus (effets exécutés dans l'ordre) : un élément focalisé hors de la zone ferait défiler l'ancêtre qui rogne.
    const placed = source.indexOf("if (open) position();");
    const focusedAt = source.indexOf("itemRefs.current[focused]?.focus()");
    assert.ok(placed > 0 && focusedAt > placed, "le menu doit être placé avant que le focus n'y entre");
  });

  it("feuille de style : aucune animation, menu défilant, focus visible, forced-colors, texte secondaire en --text-2 (jamais une opacité)", () => {
    const css = read(CSS_FILE).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(css, /\banimation\b|@keyframes|\binfinite\b/);
    assert.doesNotMatch(css, /\bopacity\b/);
    assert.match(css, /\.autonomy-menu \{[^}]*overflow: auto;/);
    assert.match(css, /\.autonomy-item:focus-visible \{[^}]*outline: 2px solid var\(--accent\)/);
    assert.match(css, /@media \(forced-colors: active\)/);
    assert.match(css, /\.autonomy-item-reason \{[^}]*color: var\(--text-2\)/);
    assert.match(css, /\.autonomy-menu\[data-ouverture="haut"\]/);
    assert.match(css, /\.autonomy-menu\[data-ouverture="bas"\]/);
  });

  it("pureté : le modèle n'importe que les textes et les types de l'autonomie ; ni module node, ni process, ni horloge, ni DOM", () => {
    const source = read(MODEL_FILE);
    const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((m) => m[1]);
    assert.deepEqual(imports, ["./autonomy-choice-texts.ts", "./autonomy-types.ts"]);
    for (const forbidden of [/"node:/, /\bprocess\./, /\bDate\b/, /Math\.random/, /\bfetch\s*\(/, /\bset(?:Timeout|Interval)\b/, /\bwindow\b/, /\bdocument\b/]) {
      assert.doesNotMatch(source, forbidden);
    }
  });
});
