// Tests du sélecteur « Autonomie » et de la confirmation d'un choix automatique (L6s puis L12a ; spécification §4.1, §4.8.1,
// §4.9 point 1, §4.11, §4.13, §5.5, §5.6, P7 ; plan d'exécution, fiches L6s et L12a).
// Le modèle pur (server/shared/autonomy-menu.ts) porte toute la logique : quatre éléments `menuitemradio` dans l'ordre du §4.1,
// un seul coché, choix indisponibles désactivés avec la raison du serveur, « Plan d'abord (nouvelle conversation) », clavier APG,
// placement et bornes à 400 px, suite d'un refus (428 → confirmation, 403 et 409 → phrase du serveur), lignes et plafonds bornés
// de la confirmation, dans les deux variantes de l'IA de contrôle.
// L'interface n'étant pas exécutée par `npm test`, les composants et la feuille de style sont relus (contrat statique P7 : rôles
// ARIA, aucun raccourci global, aucun texte recopié, aucune animation).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { Cockpit11Deps } from "./contracts-11.ts";
import { neutralConversationAutonomy } from "./conversation-autonomy.ts";
import { DEFAULT_SETTINGS, settingsSchema } from "./settings.ts";
import { descriptionChoix, libelleChoix, raisonIndisponible, TEXTES } from "./shared/autonomy-choice-texts.ts";
import {
  activateItem,
  autonomyPutBody,
  type AutonomyMenu,
  type AutonomyMenuInput,
  buildAutonomyConfirm,
  buildAutonomyMenu,
  buttonKey,
  CAP_BOUNDS,
  CAP_ORDER,
  CAP_UNIT,
  capInput,
  capInputs,
  type CapKey,
  capsFromInputs,
  capsSignature,
  CHOICE_ICONS,
  choiceFailure,
  clampCap,
  clampCaps,
  horizontalShift,
  intersectArea,
  isAutomaticChoice,
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
import { confirmationAutonome, confirmationModifications, montant, TEXTES as PHRASES } from "./shared/autonomy-texts.ts";
import type { AutonomyCaps, AutonomyChoice, AutonomyChoiceAvailability, ConversationAutonomyView } from "./shared/autonomy-types.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(APP_DIR, rel), "utf8");
const MODEL_FILE = "server/shared/autonomy-menu.ts";
const COMPONENT_FILE = "web/pages/chat/autonomy/AutonomySelector.tsx";
const CONFIRM_FILE = "web/pages/chat/autonomy/AutonomyConfirm.tsx";
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

  it("L12a : les quatre choix sont utilisables quand le serveur les donne disponibles ; un seul élément coché (aria-checked)", () => {
    // Les deux choix automatiques ne sont plus bridés par le sélecteur : SELECTOR_CHOICES est l'ordre complet du §4.1.
    assert.deepEqual(SELECTOR_CHOICES, MENU_ORDER);
    assert.deepEqual([...SELECTOR_CHOICES], ["demander", "modifications", "plan", "autonome"]);
    const view = viewOf("ses_c", "demander", OPEN_DISPONIBLES);
    const menu = build({ rootId: "ses_c", view, boot: { interrupteur: true, activationOuverte: true } });
    assert.deepEqual(summary(menu), [
      ["demander", true, false, null, "aucune"],
      ["modifications", false, false, null, "choix"],
      ["plan", false, false, null, "plan"],
      ["autonome", false, false, null, "choix"],
    ]);
    assert.equal(menu.items.filter((item) => item.coche).length, 1, "aria-checked sur un seul élément");
    assert.ok(menu.items.every((item) => item.raison === null));
    // Un choix automatique en vigueur : lui seul est coché, et le garder n'envoie rien.
    for (const courant of ["modifications", "autonome"] as const) {
      const actif = build({ rootId: "ses_c", view: viewOf("ses_c", courant, OPEN_DISPONIBLES) });
      assert.deepEqual(
        actif.items.filter((item) => item.coche).map((item) => [item.choix, item.action]),
        [[courant, "aucune"]],
      );
    }
  });

  it("porte I1 : la disponibilité vient du serveur, jamais d'une condition sur ACTIVATION_OUVERTE dans l'interface", () => {
    // Porte fermée : le serveur donne les deux choix automatiques indisponibles avec « a-venir » ; l'interface les affiche tels quels.
    const fermee = viewOf("ses_i", "demander", [
      { choix: "demander", disponible: true, raison: null },
      { choix: "modifications", disponible: false, raison: "a-venir" },
      { choix: "plan", disponible: false, raison: "nouvelle-conversation" },
      { choix: "autonome", disponible: false, raison: "a-venir" },
    ]);
    const avant = build({ rootId: "ses_i", view: fermee, boot: { interrupteur: true, activationOuverte: false } });
    assert.deepEqual(
      avant.items.map((i) => [i.desactive, i.raisonCode]),
      [
        [false, null],
        [true, "a-venir"],
        [false, null],
        [true, "a-venir"],
      ],
    );
    assert.equal(avant.items[1]?.raison, TEXTES.partout.raisons["a-venir"]);
    // Après la bascule, la même vue devenue ouverte suffit : aucun composant ni modèle n'a à changer.
    const apres = build({ rootId: "ses_i", view: viewOf("ses_i", "demander", OPEN_DISPONIBLES), boot: { interrupteur: true, activationOuverte: false } });
    assert.deepEqual(
      apres.items.map((i) => i.desactive),
      [false, false, false, false],
    );
    // Aucune vue (conversation neuve) : l'amorçage du serveur porte la porte, et lui seul.
    const neuveFermee = build({ rootId: null, view: null, boot: { interrupteur: true, activationOuverte: false } });
    const neuveOuverte = build({ rootId: null, view: null, boot: { interrupteur: true, activationOuverte: true } });
    assert.deepEqual(
      neuveFermee.items.map((i) => [i.desactive, i.raisonCode]),
      [
        [false, null],
        [true, "a-venir"],
        [false, null],
        [true, "a-venir"],
      ],
    );
    assert.deepEqual(
      neuveOuverte.items.map((i) => i.desactive),
      [false, false, false, false],
    );
    // Interrupteur coupé : il l'emporte sur la porte ouverte (décision n° 13).
    const coupee = build({ rootId: null, view: null, boot: { interrupteur: false, activationOuverte: true } });
    assert.deepEqual(
      coupee.items.map((i) => [i.desactive, i.raisonCode]),
      [
        [false, null],
        [true, "autonomie-coupee"],
        [false, null],
        [true, "autonomie-coupee"],
      ],
    );
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
    // « Modifications automatiques » (resserrer, §4.11) reste utilisable : le serveur le donne disponible.
    assert.deepEqual(kept.items[1] && [kept.items[1].desactive, kept.items[1].action], [false, "choix"]);
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

  it("activation : désactivé → rien, menu ouvert ; coché → fermeture sans envoi ; un choix → PUT ; « Plan d'abord » → POST /api/plans", () => {
    const menu = build({ rootId: "ses_g", view: viewOf("ses_g", "demander", OPEN_DISPONIBLES) });
    const [demander, modifications, plan, autonome] = menu.items;
    assert.ok(demander && modifications && plan && autonome);
    assert.deepEqual(activateItem(demander), { fermer: true, envoi: null });
    assert.deepEqual(activateItem(modifications), { fermer: true, envoi: "choix" });
    assert.deepEqual(activateItem(autonome), { fermer: true, envoi: "choix" });
    assert.deepEqual(activateItem(plan), { fermer: true, envoi: "plan" });
    // Choix refusé par le serveur : le menu reste ouvert, rien n'est envoyé (sa raison est lue).
    const refuse = build({
      rootId: "ses_g",
      view: viewOf("ses_g", "demander", [
        { choix: "demander", disponible: true, raison: null },
        { choix: "modifications", disponible: false, raison: "a-venir" },
        { choix: "plan", disponible: false, raison: "nouvelle-conversation" },
        { choix: "autonome", disponible: false, raison: "a-venir" },
      ]),
    });
    assert.deepEqual(refuse.items[1] && activateItem(refuse.items[1]), { fermer: false, envoi: null });
    assert.deepEqual(refuse.items[3] && activateItem(refuse.items[3]), { fermer: false, envoi: null });
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
    // Actions : PUT du choix (corps et en-tête choisis par le modèle), POST /api/plans puis ouverture de la conversation.
    assert.match(source, /autonomyApi\.put\(target, autonomyPutBody\(choix, caps\), caps !== null \? \{ confirm: true \} : \{\}\)/);
    // Conversation d'origine du plan (plan_source_id, train it1 V3) : la conversation ouverte, aucune pour une nouvelle.
    assert.match(source, /const source = rootId \?\? undefined;/);
    assert.match(source, /planApi\.create\(directory, \{ source \}\)/);
    assert.match(source, /planApi\.create\(directory, \{ confirm: true, source \}\)/);
    assert.match(source, /onOpenConversation\(created\.rootId, null\)/);
    // Le composant ne décide rien : il lit le modèle ; l'IA de contrôle est LUE dans les réglages de l'amorçage, jamais déduite.
    assert.match(source, /buildAutonomyMenu\(\{ rootId, view, boot: boot\.autonomy, controleIa: reglages\.controleIa \}\)/);
    assert.match(source, /const reglages = boot\.settings\.budget\.autonomie;/);
    // Suite d'un refus : c'est le modèle qui tranche (428 → confirmation, 403 et 409 → phrase du serveur), jamais le composant.
    assert.match(source, /choiceFailure\(choix, autonomyError\(err\), texte, caps !== null\)/);
    assert.doesNotMatch(source, /\bACTIVATION_OUVERTE\b|activationOuverte/);
  });

  it("confirmation : propriétés figées de T2, textes et bornes du modèle, plafonds bornés, aucun texte en dur, aucune animation", () => {
    const source = read(CONFIRM_FILE);
    // Propriétés figées par T2 (slots.ts) : la signature ne change pas sans demande écrite à l'intégrateur.
    assert.match(source, /\{ open, choix, directory, plafonds, busy = false, onConfirm, onCancel \}: AutonomyConfirmProps/);
    const slots = read("web/pages/chat/slots.ts");
    const figees = slots.slice(slots.indexOf("export interface AutonomyConfirmProps"), slots.indexOf("// --- Chat : demandes"));
    for (const prop of ["open:", "choix:", "directory:", "plafonds:", "busy?:", "onConfirm:", "onCancel:"]) {
      assert.ok(figees.includes(prop), `propriété figée absente de slots.ts : ${prop}`);
    }
    // Aucun texte affiché en dur : titre, lignes, boutons et libellés des plafonds viennent du modèle (donc de L9b).
    const jsxText = [...source.matchAll(/>([^<>{}()=;]*\p{L}[^<>{}()=;]*)</gu)].map((m) => (m[1] ?? "").trim()).filter(Boolean);
    assert.deepEqual(jsxText, []);
    assert.doesNotMatch(source, /\b(?:aria-label|title|placeholder|alt)="/);
    for (const needle of [
      "buildAutonomyConfirm({",
      "controleIa: reglages.controleIa",
      "const reglages = boot.settings.budget.autonomie;",
      "clampCaps(plafonds, reglages.plafondMaxUsd)",
      "capsFromInputs(valeurs, proposes, reglages.plafondMaxUsd)",
      "min={champ.min}",
      "max={champ.max}",
      "step={champ.pas}",
      "onConfirm(caps)",
      "onClose={onCancel}",
      "{modele.titre}",
      "{ligne.texte}",
      "{champ.libelle}",
      "{modele.valider}",
      "{modele.annuler}",
      '<Icon name={ligne.icone}',
      'htmlFor={`${baseId}-${champ.cle}`}',
      'import "./autonomy-selector.css";',
    ]) {
      assert.ok(source.includes(needle), `absent : ${needle}`);
    }
    // Aucun raccourci global (Échap est celui de la fenêtre de components/ui.tsx), aucune animation, aucun texte de L9b recopié.
    assert.doesNotMatch(source, /addEventListener\(\s*["']key(?:down|up|press)["']/);
    assert.doesNotMatch(source, /\baccessKey\b|\bshiftKey\b|\banimate\(/);
    for (const phrase of [PHRASES.partout.confirmationAutonome.titre, PHRASES.partout.confirmationModifications.titre, PHRASES.partout.commandes.lancerAutonome]) {
      assert.equal(withoutComments(source).includes(phrase), false, `« ${phrase} » recopié dans la confirmation`);
    }
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

  it("emplacement de l'en-tête (ChatPage.tsx) : un seul sélecteur, hors du choix « conversation chargée ou non » ; le focus reste sur lui quand « Plan d'abord (nouvelle conversation) » ouvre la conversation de plan", () => {
    // Répétition générale de l'itération 1 : deux sélecteurs, un par branche ; la conversation rechargée (session remise à null puis
    // relue) démontait le bouton focalisé et le focus tombait sur la page (document.body). Relevé au clavier par it1-ui-selecteur-clavier.
    const chat = withoutComments(read("web/pages/ChatPage.tsx"));
    const header = chat.slice(chat.indexOf('<header className="chat-header">'), chat.indexOf("</header>"));
    assert.ok(header.length > 0, "en-tête du chat introuvable");
    assert.equal(header.match(/<AutonomySelector\b/g)?.length, 1, "un seul sélecteur dans l'en-tête");
    assert.match(header, /\)\}\s*(?:\{\}\s*)?<AutonomySelector placement="header" \{\.\.\.selectorProps\} \/>\s*\{session \? \(/, "sélecteur enfant direct de l'en-tête, entre les deux choix");
  });

  it("feuille de style : aucune animation, menu défilant, focus visible, forced-colors, une colonne de plafonds à 400 px, jamais une opacité", () => {
    const css = read(CSS_FILE).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(css, /\banimation\b|@keyframes|\binfinite\b/);
    assert.doesNotMatch(css, /\bopacity\b/);
    assert.match(css, /\.autonomy-menu \{[^}]*overflow: auto;/);
    assert.match(css, /\.autonomy-item:focus-visible \{[^}]*outline: 2px solid var\(--accent\)/);
    assert.match(css, /@media \(forced-colors: active\)/);
    assert.match(css, /\.autonomy-item-reason \{[^}]*color: var\(--text-2\)/);
    assert.match(css, /\.autonomy-menu\[data-ouverture="haut"\]/);
    assert.match(css, /\.autonomy-menu\[data-ouverture="bas"\]/);
    // Confirmation : icône devant chaque ligne, plafonds sur une seule colonne sous 480 px (§5.6), focus et bordures en
    // forced-colors. Le défilement de la feuille est celui du corps de la fenêtre (.modal-body de styles.css).
    assert.match(css, /\.autonomy-confirm-line \{[^}]*grid-template-columns: 14px minmax\(0, 1fr\);/);
    assert.match(css, /@media \(max-width: 480px\) \{[\s\S]*?\.autonomy-confirm-caps \{\s*grid-template-columns: minmax\(0, 1fr\);/);
    assert.match(css, /@media \(forced-colors: active\) \{[\s\S]*?\.autonomy-confirm-input:focus-visible \{\s*outline: 2px solid Highlight;/);
    assert.match(read("web/styles.css"), /\.modal-body \{[^}]*overflow: auto;/);
  });

  it("pureté : le modèle n'importe que les textes, les modes et les types de l'autonomie ; ni module node, ni process, ni horloge, ni DOM", () => {
    const source = read(MODEL_FILE);
    const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((m) => m[1]);
    assert.deepEqual(imports, ["./assistant-rules.ts", "./autonomy-choice-texts.ts", "./autonomy-texts.ts", "./autonomy-types.ts"]);
    for (const forbidden of [/"node:/, /\bprocess\./, /\bDate\b/, /Math\.random/, /\bfetch\s*\(/, /\bset(?:Timeout|Interval)\b/, /\bwindow\b/, /\bdocument\b/]) {
      assert.doesNotMatch(source, forbidden);
    }
  });
});

// --- Suite d'un choix refusé (§4.11 : resserrer immédiat, relâcher confirmé) ------------------------------------------------------

/** Plafonds par défaut des réglages, forme d'AutonomyCaps (ceux que le serveur propose à une conversation neuve). */
function defaultCaps(): AutonomyCaps {
  const caps = DEFAULT_SETTINGS.budget.autonomie;
  return {
    plafondUsd: caps.plafondUsd,
    actionsMax: caps.actionsMax,
    delegationsMax: caps.delegationsMax,
    dureeMinutes: caps.dureeMinutes,
    fichiersMax: caps.fichiersMax,
    controlesIaMax: caps.controlesIaMax,
  };
}

const DOSSIER = "/projets/site";
const PHRASE_SERVEUR = "phrase du serveur";

describe("autonomy-menu : suite d'un PUT refusé (428 → confirmation ; 403 et 409 → phrase du serveur)", () => {
  it("428 confirmation-requise sur un choix automatique, appel sans en-tête : la confirmation s'ouvre", () => {
    for (const choix of ["modifications", "autonome"] as const) {
      assert.equal(isAutomaticChoice(choix), true);
      assert.deepEqual(choiceFailure(choix, { error: "confirmation-requise" }, PHRASE_SERVEUR, false), { kind: "confirmer", choix });
    }
  });

  it("jamais deux confirmations de suite : un 428 sur un appel déjà confirmé rend la phrase du serveur", () => {
    assert.deepEqual(choiceFailure("autonome", { error: "confirmation-requise" }, PHRASE_SERVEUR, true), { kind: "message", texte: PHRASE_SERVEUR });
  });

  it("resserrer ne confirme jamais : « Demander à chaque fois » et « Plan d'abord » rendent la phrase, même sur un 428", () => {
    for (const choix of ["demander", "plan"] as const) {
      assert.equal(isAutomaticChoice(choix), false);
      assert.deepEqual(choiceFailure(choix, { error: "confirmation-requise" }, PHRASE_SERVEUR, false), { kind: "message", texte: PHRASE_SERVEUR });
    }
  });

  it("403 autonomie-coupee, 409 autonomie-indisponible et raccourci refusé : la raison du serveur, telle quelle", () => {
    for (const error of ["autonomie-coupee", "autonomie-indisponible", "raccourci-refuse-autonomie"] as const) {
      assert.deepEqual(choiceFailure("autonome", { error }, PHRASE_SERVEUR, false), { kind: "message", texte: PHRASE_SERVEUR });
    }
    // 409 avec sa raison en code : la phrase reste celle du serveur, jamais refaite à partir du code.
    assert.deepEqual(choiceFailure("modifications", { error: "autonomie-indisponible", raison: "regle-allow" }, PHRASE_SERVEUR, false), {
      kind: "message",
      texte: PHRASE_SERVEUR,
    });
    // Erreur sans corps d'autonomie (réseau, 500) : la phrase du client HTTP.
    assert.deepEqual(choiceFailure("autonome", null, PHRASE_SERVEUR, false), { kind: "message", texte: PHRASE_SERVEUR });
  });

  it("corps du PUT : les plafonds ne partent qu'avec « Autonome avec contrôle », et seulement après confirmation", () => {
    const caps = defaultCaps();
    assert.deepEqual(autonomyPutBody("autonome", caps), { choix: "autonome", plafonds: caps });
    assert.deepEqual(autonomyPutBody("autonome", null), { choix: "autonome" });
    // « Modifications automatiques » n'a aucun plafond (§4.8.1) : en envoyer en écrirait que sa confirmation ne montre pas.
    assert.deepEqual(autonomyPutBody("modifications", caps), { choix: "modifications" });
    assert.deepEqual(autonomyPutBody("demander", caps), { choix: "demander" });
  });
});

// --- Confirmation d'un choix automatique (§4.11, §4.13) ---------------------------------------------------------------------------

describe("autonomy-menu : confirmation d'« Autonome avec contrôle » (§4.13), dans les deux variantes", () => {
  const confirmOf = (controleIa: boolean, plafonds: AutonomyCaps = defaultCaps(), plafondMaxUsd = DEFAULT_SETTINGS.budget.autonomie.plafondMaxUsd) =>
    buildAutonomyConfirm({ choix: "autonome", dossier: DOSSIER, plafonds, controleIa, plafondMaxUsd, mode: "simple" });

  it("titre et lignes exactes du §4.13, {dossier} et {x} remplis, sans doublon : ce sont celles de confirmationAutonome() (L9b)", () => {
    for (const controleIa of [true, false]) {
      const modele = confirmOf(controleIa);
      const textes = confirmationAutonome({ controleIa, dossier: DOSSIER, plafondUsd: 1 });
      assert.equal(modele.titre, textes.titre);
      assert.equal(modele.titre, "Laisser l'IA travailler seule dans cette conversation ?");
      assert.deepEqual(
        modele.lignes.map((l) => l.texte),
        textes.lignes,
        `variante controleIa=${controleIa}`,
      );
      assert.equal(modele.valider, textes.lancer);
      assert.equal(modele.valider, "Lancer en autonome");
      assert.equal(modele.annuler, textes.annuler);
      assert.equal(modele.annuler, "Annuler");
      // {dossier} rempli dans la première ligne, {x} dans la ligne d'arrêt (montant de L9b, « 1,00 $ »).
      assert.ok(modele.lignes[0]?.texte.includes(DOSSIER), "{dossier} non rempli");
      assert.ok(modele.lignes[3]?.texte.startsWith(`Arrêt automatique à ${montant(1)}`), modele.lignes[3]?.texte);
      assert.ok(modele.lignes[3]?.texte.includes(PHRASES.partout.depassement), "le dépassement possible n'est pas dit");
      // Lignes 2, 3 et 5 : phrases du §4.13, les mêmes dans les deux variantes.
      assert.equal(
        modele.lignes[1]?.texte,
        "Toujours avec votre accord : fichiers protégés, suppressions, hors projet, web, commandes qui exécutent du code ou touchent au réseau, à la production ou à git.",
      );
      assert.equal(modele.lignes[2]?.texte, "Jamais : ce que l'assistant refuse.");
      assert.equal(
        modele.lignes[4]?.texte,
        "Certaines actions d'opencode ne passent par aucune demande : le cockpit les repère après coup et arrête la demande.",
      );
    }
  });

  it("variante lue dans budget.autonomie.controleIa (jamais déduite) : « Sans vous demander » change, le reste non", () => {
    const avec = confirmOf(true);
    const sans = confirmOf(false);
    assert.equal(
      avec.lignes[0]?.texte,
      `Sans vous demander : modifier les fichiers de ${DOSSIER} sauf fichiers protégés ; lancer des commandes de consultation ; faire juger les autres commandes simples par l'IA de contrôle (chaque contrôle est facturé) ; confier du travail dans les plafonds.`,
    );
    assert.equal(
      sans.lignes[0]?.texte,
      `Sans vous demander : modifier les fichiers de ${DOSSIER} sauf fichiers protégés ; lancer des commandes de consultation ; confier du travail dans les plafonds. Les autres commandes attendent votre accord.`,
    );
    assert.notEqual(avec.lignes[0]?.texte, sans.lignes[0]?.texte);
    assert.deepEqual(
      avec.lignes.slice(1).map((l) => l.texte),
      sans.lignes.slice(1).map((l) => l.texte),
    );
  });

  it("icône ET texte sur chaque ligne (jamais la couleur seule), une icône par ligne", () => {
    const modele = confirmOf(true);
    assert.equal(modele.lignes.length, 5);
    for (const ligne of modele.lignes) {
      assert.ok(ligne.texte.length > 0);
      assert.ok(ligne.icone.length > 0);
    }
    assert.equal(new Set(modele.lignes.map((l) => l.icone)).size, 5, "une icône par ligne");
  });

  it("plafonds modifiables et bornés : six champs, libellés de L9b, unité du gabarit de montant ; le coût borné par plafondMaxUsd", () => {
    const modele = confirmOf(true);
    assert.deepEqual(
      modele.champs.map((c) => c.cle),
      [...CAP_ORDER],
    );
    const { libelles } = PHRASES.partout.plafonds;
    for (const champ of modele.champs) {
      assert.equal(champ.libelle, libelles[champ.cle]);
      assert.equal(champ.min, CAP_BOUNDS[champ.cle].min);
      assert.equal(champ.pas, CAP_BOUNDS[champ.cle].pas);
      assert.equal(champ.entier, CAP_BOUNDS[champ.cle].entier);
      assert.equal(champ.unite, champ.cle === "plafondUsd" ? CAP_UNIT : null);
    }
    assert.equal(CAP_UNIT, "$");
    // Borne haute du coût : celle des réglages (5 $ par défaut), jamais la borne du schéma seule.
    assert.equal(modele.champs[0]?.max, DEFAULT_SETTINGS.budget.autonomie.plafondMaxUsd);
    assert.equal(confirmOf(true, defaultCaps(), 2.5).champs[0]?.max, 2.5);
    assert.equal(confirmOf(true, defaultCaps(), 999).champs[0]?.max, CAP_BOUNDS.plafondUsd.max);
    assert.equal(confirmOf(true, defaultCaps(), Number.NaN).champs[0]?.max, CAP_BOUNDS.plafondUsd.max);
    assert.equal(modele.champs[1]?.max, CAP_BOUNDS.actionsMax.max);
  });

  it("IA de contrôle coupée : le plafond de contrôles par IA n'est pas proposé (elle n'est jamais consultée, §7.4)", () => {
    const sans = confirmOf(false);
    assert.deepEqual(
      sans.champs.map((c) => c.cle),
      CAP_ORDER.filter((cle) => cle !== "controlesIaMax"),
    );
    assert.equal(
      sans.champs.some((c) => c.cle === "controlesIaMax"),
      false,
    );
    assert.equal(
      confirmOf(true).champs.some((c) => c.cle === "controlesIaMax"),
      true,
    );
  });

  it("plafonds hors bornes (réglage abaissé) : ramenés avant d'être montrés, et {x} suit le plafond ramené", () => {
    const hauts: AutonomyCaps = { ...defaultCaps(), plafondUsd: 40, actionsMax: 9_000, dureeMinutes: 0 };
    const modele = confirmOf(true, hauts, 2);
    // {x} de la ligne d'arrêt : le plafond RAMENÉ (2 $), jamais les 40 $ proposés que le serveur refuserait.
    assert.ok(modele.lignes[3]?.texte.startsWith(`Arrêt automatique à ${montant(2)}`), modele.lignes[3]?.texte);
    assert.equal(modele.lignes[3]?.texte.includes(montant(40)), false);
  });
});

describe("autonomy-menu : première confirmation de « Modifications automatiques » (§4.11)", () => {
  const confirmOf = (mode: "simple" | "avance") =>
    buildAutonomyConfirm({
      choix: "modifications",
      dossier: DOSSIER,
      plafonds: defaultCaps(),
      controleIa: true,
      plafondMaxUsd: DEFAULT_SETTINGS.budget.autonomie.plafondMaxUsd,
      mode,
    });

  it("titre, trois lignes et [Activer] de confirmationModifications() (L9b) ; aucun plafond (§4.8.1)", () => {
    for (const mode of ["simple", "avance"] as const) {
      const modele = confirmOf(mode);
      const textes = confirmationModifications({ mode, dossier: DOSSIER });
      assert.equal(modele.titre, textes.titre);
      assert.deepEqual(
        modele.lignes.map((l) => l.texte),
        textes.lignes,
      );
      assert.equal(modele.valider, textes.activer);
      assert.equal(modele.valider, "Activer");
      assert.equal(modele.annuler, "Annuler");
      assert.deepEqual(modele.champs, [], "« Modifications automatiques » n'a aucun plafond");
      assert.ok(modele.lignes[0]?.texte.includes(DOSSIER));
      assert.equal(new Set(modele.lignes.map((l) => l.icone)).size, 3);
    }
    // Le travail délégué n'est cité qu'en mode Avancé (décision n° 4) : la ligne d'accord change avec le mode.
    assert.notEqual(confirmOf("simple").lignes[1]?.texte, confirmOf("avance").lignes[1]?.texte);
  });
});

// --- Plafonds bornés (§4.8.1) -----------------------------------------------------------------------------------------------------

describe("autonomy-menu : plafonds bornés comme le serveur les borne (§4.8.1)", () => {
  /** Réglages complets avec le plafond `cle` mis à `valeur` (plafondMaxUsd ouvert au maximum pour isoler le plafond testé). */
  const withCap = (cle: CapKey, valeur: number) => ({
    ...DEFAULT_SETTINGS,
    budget: {
      ...DEFAULT_SETTINGS.budget,
      autonomie: { ...DEFAULT_SETTINGS.budget.autonomie, plafondMaxUsd: CAP_BOUNDS.plafondUsd.max, [cle]: valeur },
    },
  });

  it("CAP_ORDER couvre les six plafonds, une seule fois", () => {
    assert.deepEqual([...CAP_ORDER].sort(), Object.keys(defaultCaps()).sort());
    assert.equal(new Set(CAP_ORDER).size, CAP_ORDER.length);
    assert.deepEqual(Object.keys(CAP_BOUNDS).sort(), [...CAP_ORDER].sort());
  });

  it("chaque borne est celle du schéma des réglages : la confirmation n'envoie jamais un plafond que le serveur refuserait", () => {
    assert.equal(settingsSchema.safeParse(DEFAULT_SETTINGS).success, true, "les réglages par défaut doivent passer le schéma");
    for (const cle of CAP_ORDER) {
      const { min, max, pas } = CAP_BOUNDS[cle];
      assert.equal(settingsSchema.safeParse(withCap(cle, min)).success, true, `${cle} : borne basse refusée par le schéma`);
      assert.equal(settingsSchema.safeParse(withCap(cle, max)).success, true, `${cle} : borne haute refusée par le schéma`);
      assert.equal(settingsSchema.safeParse(withCap(cle, min - pas)).success, false, `${cle} : sous la borne basse accepté`);
      assert.equal(settingsSchema.safeParse(withCap(cle, max + pas)).success, false, `${cle} : au-delà de la borne haute accepté`);
    }
  });

  it("clampCap : valeur illisible → défaut, entiers arrondis, coût à deux décimales, coût borné par plafondMaxUsd", () => {
    assert.equal(clampCap("actionsMax", 12.4, 60), 12);
    assert.equal(clampCap("actionsMax", 9_000, 60), CAP_BOUNDS.actionsMax.max);
    assert.equal(clampCap("actionsMax", 0, 60), CAP_BOUNDS.actionsMax.min);
    assert.equal(clampCap("actionsMax", Number.NaN, 60), 60);
    assert.equal(clampCap("actionsMax", Number.NaN, Number.NaN), CAP_BOUNDS.actionsMax.min);
    assert.equal(clampCap("delegationsMax", 0, 5), 0, "les délégations descendent à 0");
    assert.equal(clampCap("plafondUsd", 1.239, 1), 1.24);
    assert.equal(clampCap("plafondUsd", 0, 1), CAP_BOUNDS.plafondUsd.min);
    assert.equal(clampCap("plafondUsd", 40, 1, 5), 5, "jamais au-delà du plafond maximal des réglages");
    assert.equal(clampCap("plafondUsd", 80, 1, 999), CAP_BOUNDS.plafondUsd.max, "ni au-delà de la borne du schéma");
    assert.equal(clampCap("plafondUsd", 3, 1, Number.NaN), 3);
  });

  it("clampCaps : chaque plafond ramené dans ses bornes, y compris ceux qui viennent du serveur", () => {
    const borne = clampCaps({ plafondUsd: 40, actionsMax: 0, delegationsMax: -3, dureeMinutes: 9_000, fichiersMax: 25.6, controlesIaMax: 20 }, 5);
    assert.deepEqual(borne, {
      plafondUsd: 5,
      actionsMax: CAP_BOUNDS.actionsMax.min,
      delegationsMax: CAP_BOUNDS.delegationsMax.min,
      dureeMinutes: CAP_BOUNDS.dureeMinutes.max,
      fichiersMax: 26,
      controlesIaMax: 20,
    });
    assert.deepEqual(clampCaps(defaultCaps(), 5), defaultCaps(), "des plafonds déjà valides ne bougent pas");
  });

  it("saisies : un champ vide, illisible ou absent garde le plafond proposé ; la virgule décimale est lue", () => {
    const proposes = defaultCaps();
    assert.deepEqual(capInputs(proposes), {
      plafondUsd: "1.00",
      actionsMax: "60",
      delegationsMax: "5",
      dureeMinutes: "30",
      fichiersMax: "25",
      controlesIaMax: "20",
    });
    assert.equal(capInput("plafondUsd", 2.5), "2.50");
    assert.deepEqual(capsFromInputs({ ...capInputs(proposes), actionsMax: "" }, proposes), proposes, "champ vide : plafond proposé");
    assert.deepEqual(capsFromInputs({ ...capInputs(proposes), actionsMax: "abc" }, proposes), proposes, "champ illisible : plafond proposé");
    assert.deepEqual(capsFromInputs({}, proposes), proposes, "champ absent (contrôles par IA coupés) : plafond proposé");
    assert.equal(capsFromInputs({ ...capInputs(proposes), plafondUsd: "2,50" }, proposes).plafondUsd, 2.5);
    assert.equal(capsFromInputs({ ...capInputs(proposes), plafondUsd: "40" }, proposes, 5).plafondUsd, 5);
    assert.equal(capsFromInputs({ ...capInputs(proposes), actionsMax: "9000" }, proposes).actionsMax, CAP_BOUNDS.actionsMax.max);
    assert.equal(capsFromInputs({ ...capInputs(proposes), dureeMinutes: " 45 " }, proposes).dureeMinutes, 45);
  });

  it("signature : mêmes valeurs, même signature (une saisie en cours n'est pas effacée par un simple réaffichage)", () => {
    const a = defaultCaps();
    const b = { ...defaultCaps() };
    assert.notEqual(a, b, "deux objets distincts");
    assert.equal(capsSignature(a), capsSignature(b));
    assert.notEqual(capsSignature(a), capsSignature({ ...a, plafondUsd: 2 }));
    assert.notEqual(capsSignature(a), capsSignature({ ...a, controlesIaMax: 0 }));
  });
});

// --- Descriptions des choix, dans les deux variantes ------------------------------------------------------------------------------

describe("autonomy-menu : descriptions des quatre choix (§4.13), variante de l'IA de contrôle", () => {
  it("descriptions exactes du §4.13 ; « Autonome avec contrôle » suit budget.autonomie.controleIa", () => {
    const disponibles = OPEN_DISPONIBLES;
    const avec = build({ rootId: "ses_v", view: viewOf("ses_v", "demander", disponibles), controleIa: true });
    const sans = build({ rootId: "ses_v", view: viewOf("ses_v", "demander", disponibles), controleIa: false });
    assert.equal(avec.items[0]?.description, "L'IA lit, puis vous demande avant chaque modification, commande, accès web ou travail délégué.");
    assert.equal(
      avec.items[1]?.description,
      "L'IA modifie les fichiers de ce dossier sans vous demander, sauf les fichiers protégés. Elle demande pour tout le reste.",
    );
    assert.equal(avec.items[2]?.description, "L'IA propose un plan dans une nouvelle conversation qui ne peut rien modifier.");
    assert.equal(
      avec.items[3]?.description,
      "L'IA enchaîne le travail. Le cockpit laisse passer les actions jugées sûres et vous demande pour tout le reste. Arrêt automatique aux plafonds.",
    );
    // Sans IA de contrôle : seule la description d'« Autonome avec contrôle » change (TEXTES_VARIANTES de L6a).
    assert.equal(sans.items[3]?.description, descriptionChoix("autonome", false));
    assert.notEqual(sans.items[3]?.description, avec.items[3]?.description);
    assert.deepEqual(
      sans.items.slice(0, 3).map((i) => i.description),
      avec.items.slice(0, 3).map((i) => i.description),
    );
    // Absent : IA de contrôle en service, comme le réglage par défaut.
    assert.equal(build({ rootId: "ses_v", view: viewOf("ses_v", "demander", disponibles) }).items[3]?.description, avec.items[3]?.description);
    assert.equal(DEFAULT_SETTINGS.budget.autonomie.controleIa, true);
  });
});
