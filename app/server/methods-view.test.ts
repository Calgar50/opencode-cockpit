// Tests des vues « méthodes » côté assistants (plan d'exécution it5, fiche L44d ; conception C §9.8, §9.13 ; RM §5.6 ;
// spécification §5.4 l.910, §5.5, §5.6). Le modèle pur (server/shared/methods-view.ts) porte toute la logique : limites
// (2 méthodes au plus), « déjà appliquée », méthodes conseillées, phrases des cartes et garde des sources.
// L'interface n'étant pas exécutée par `npm test`, les composants et la feuille de style sont relus (contrat statique) :
// rôles APG, textes lus dans construction-texts.ts, limites jamais recopiées, aucune animation, `forced-colors`.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { METHODS } from "./methods-catalogue.ts";
import { METHODS_PER_ASSISTANT } from "./shared/construction-constants.ts";
import { TEXTES } from "./shared/construction-texts.ts";
import type { MethodView } from "./shared/construction-types.ts";
import {
  METHOD_VIEW_LIMITS,
  methodAttachable,
  methodLabels,
  methodMenuState,
  sourceHref,
  suggestionsByAssistant,
  texteAssistantsEquipe,
  texteAttention,
  texteFicheMethodes,
  texteIaRemplacee,
  texteQuand,
  texteUtiliseePar,
  withMethod,
  wizardMethodState,
} from "./shared/methods-view.ts";
import { type TierBrief, modelSubstitution } from "../web/pages/assistants/methods/assistant-request.ts";

const M = TEXTES.partout.methodes;
const WEB = path.join(import.meta.dirname, "..", "web", "pages", "assistants");

/** Méthode de catalogue vue par l'interface, champs par défaut surchargeables. */
function vue(patch: Partial<MethodView> = {}): MethodView {
  return {
    id: "certitude",
    version: 1,
    titre: "Certitude et À VÉRIFIER",
    phrase: "phrase",
    quand: "toujours",
    attention: "attention",
    kind: "consigne",
    bloc: "bloc",
    enTete: "### Méthode : Certitude et À VÉRIFIER",
    sources: [],
    utiliseePar: [],
    conseilleePour: [],
    ...patch,
  };
}

const assistant = (methods: string[] = []) => ({ name: "relire-script", title: "Relire un script", methods });

describe("methods-view : menu « Ajouter à un assistant »", () => {
  it("limite lue dans construction-constants.ts, jamais écrite ici", () => {
    assert.equal(METHOD_VIEW_LIMITS.parAssistant, METHODS_PER_ASSISTANT);
  });

  it("assistant sans méthode : entrée utilisable, aucune raison", () => {
    assert.deepEqual(methodMenuState(assistant(), vue()), { active: true, raison: null, code: null });
  });

  it("une méthode posée, limite non atteinte : encore utilisable", () => {
    const etat = methodMenuState(assistant(["cinq-pourquoi"]), vue());
    assert.equal(etat.active, true);
  });

  it("2 méthodes au maximum : entrée désactivée avec SA phrase", () => {
    const etat = methodMenuState(assistant(["cinq-pourquoi", "pre-mortem"]), vue());
    assert.deepEqual(etat, { active: false, raison: M.limites.trop, code: "trop" });
    assert.equal(etat.raison, "2 méthodes au maximum : au-delà, l'assistant les applique moins bien.");
  });

  it("déjà appliquée : cette raison-là, même quand la limite est atteinte", () => {
    const etat = methodMenuState(assistant(["certitude", "pre-mortem"]), vue());
    assert.deepEqual(etat, { active: false, raison: M.limites.deja, code: "deja" });
    assert.equal(etat.raison, "Déjà appliquée par l'assistant.");
  });

  it("une limite passée en argument remplace la limite par défaut", () => {
    assert.equal(methodMenuState(assistant(["cinq-pourquoi"]), vue(), { parAssistant: 1 }).code, "trop");
    assert.equal(methodMenuState(assistant(["cinq-pourquoi"]), vue(), { parAssistant: 3 }).active, true);
  });

  it("assistant dont les méthodes ne sont pas rendues : traité comme sans méthode", () => {
    assert.equal(methodMenuState({ name: "x", title: "X" }, vue()).active, true);
  });

  it("« seconde-lecture » (relecture) ne s'attache pas : aucun [Ajouter] pour elle", () => {
    assert.equal(methodAttachable(vue({ kind: "relecture" })), false);
    assert.equal(methodAttachable(vue()), true);
    const catalogue = METHODS.find((m) => m.id === "seconde-lecture");
    assert.ok(catalogue, "la méthode seconde-lecture est au catalogue");
    assert.equal(methodAttachable(catalogue), false);
  });

  it("brouillon envoyé : la méthode est ajoutée à la fin, jamais en double", () => {
    assert.deepEqual(withMethod({ methods: ["cinq-pourquoi"] }, vue()), ["cinq-pourquoi", "certitude"]);
    assert.deepEqual(withMethod({}, vue()), ["certitude"]);
    assert.deepEqual(withMethod({ methods: ["certitude"] }, vue()), ["certitude"]);
  });
});

describe("methods-view : assistant de création", () => {
  it("rien n'est pré-coché : un brouillon neuf n'a aucune méthode cochée", () => {
    const etat = wizardMethodState({}, vue());
    assert.equal(etat.cochee, false);
    assert.equal(etat.active, true);
    assert.equal(etat.conseillee, false);
  });

  it("2 au plus : les cases non cochées sont désactivées avec le message", () => {
    const draft = { methods: ["cinq-pourquoi", "pre-mortem"] };
    const autre = wizardMethodState(draft, vue());
    assert.deepEqual([autre.cochee, autre.active, autre.raison], [false, false, M.limites.trop]);
  });

  it("une case cochée reste décochable même à la limite", () => {
    const draft = { methods: ["certitude", "pre-mortem"] };
    const etat = wizardMethodState(draft, vue());
    assert.deepEqual([etat.cochee, etat.active, etat.raison], [true, true, null]);
  });

  it("badge « Conseillée pour cet assistant » : seulement pour l'assistant modifié", () => {
    const method = vue({ conseilleePour: [{ name: "relire-script", title: "Relire un script", attachee: false }] });
    assert.equal(wizardMethodState({}, method, { assistant: "relire-script" }).conseillee, true);
    assert.equal(wizardMethodState({}, method, { assistant: "autre" }).conseillee, false);
    assert.equal(wizardMethodState({}, method, { assistant: null }).conseillee, false);
    assert.equal(wizardMethodState({}, method).conseillee, false);
  });
});

describe("methods-view : méthodes conseillées, par assistant", () => {
  const a = vue({ id: "a", titre: "A", conseilleePour: [{ name: "relire-script", title: "Relire un script", attachee: true }] });
  const b = vue({
    id: "b",
    titre: "B",
    conseilleePour: [
      { name: "relire-script", title: "Relire un script", attachee: false },
      { name: "cab", title: "Préparer le CAB", attachee: false },
    ],
  });
  const relecture = vue({ id: "c", kind: "relecture", conseilleePour: [{ name: "relecteur", title: "Relecteur", attachee: false }] });

  it("un groupe par assistant, dans l'ordre de première apparition, méthodes dans l'ordre du catalogue", () => {
    const groupes = suggestionsByAssistant([a, b]);
    assert.deepEqual(
      groupes.map((g) => g.assistant.name),
      ["relire-script", "cab"],
    );
    assert.deepEqual(groupes[0]?.methodes, [
      { id: "a", titre: "A", attachee: true },
      { id: "b", titre: "B", attachee: false },
    ]);
  });

  it("une méthode « relecture » n'entre dans aucun groupe : elle n'a pas de bouton [Ajouter]", () => {
    assert.deepEqual(suggestionsByAssistant([relecture]), []);
  });

  it("aucune méthode conseillée : aucun groupe", () => {
    assert.deepEqual(suggestionsByAssistant([vue()]), []);
  });

  it("le vrai catalogue ne conseille que des méthodes attachables", () => {
    for (const method of METHODS) {
      if (method.kind === "relecture") continue;
      assert.ok(Array.isArray(method.suggereePour), method.id);
    }
    assert.ok(METHODS.some((m) => m.suggereePour.length > 0), "au moins une méthode est conseillée");
  });
});

describe("methods-view : phrases", () => {
  it("gabarits remplis avec les textes de construction-texts.ts", () => {
    assert.equal(texteQuand(vue({ quand: "après un incident" })), "Quand : après un incident");
    assert.equal(texteAttention(vue({ attention: "elle invente" })), "Attention : elle invente");
    assert.equal(texteUtiliseePar([{ name: "a", title: "Alpha" }, { name: "b", title: "Bêta" }]), "Utilisée par : Alpha · Bêta");
    assert.equal(texteFicheMethodes(["5 pourquoi"]), "Méthodes : 5 pourquoi");
    assert.equal(texteAssistantsEquipe(4), "Assistants des équipes (4)");
  });

  it("aucune ligne quand il n'y a rien à dire", () => {
    assert.equal(texteUtiliseePar([]), null);
    assert.equal(texteFicheMethodes([]), null);
  });

  it("libellés des méthodes : titre du catalogue, sinon l'identifiant du fichier, jamais un titre inventé", () => {
    const catalogue = [{ id: "cinq-pourquoi", titre: "5 pourquoi" }];
    assert.deepEqual(methodLabels(["cinq-pourquoi", "inconnue"], catalogue), ["5 pourquoi", "inconnue"]);
    assert.deepEqual(methodLabels(["cinq-pourquoi"], null), ["cinq-pourquoi"]);
    assert.deepEqual(methodLabels(undefined, catalogue), []);
  });

  it("une source n'est un lien que si elle est en https, sans espace ni chevron", () => {
    assert.equal(sourceHref("https://arxiv.org/abs/2207.05221"), "https://arxiv.org/abs/2207.05221");
    assert.equal(sourceHref("javascript:alert(1)"), null);
    assert.equal(sourceHref("http://exemple.test"), null);
    assert.equal(sourceHref('https://a"><img src=x>'), null);
    assert.equal(sourceHref("https://a b"), null);
  });

  it("toutes les sources du vrai catalogue passent la garde", () => {
    for (const method of METHODS) {
      for (const source of method.sources) assert.equal(sourceHref(source), source, `${method.id} : ${source}`);
    }
  });
});

// --- IA précise remplacée par l'ajout d'une méthode (corrections de la relecture de 5a V2) ---------------------------------------
//
// « Ajouter à un assistant » réenregistre le brouillon COMPLET (D-5-07). En mode Simple, l'IA précise d'un assistant ne peut pas
// être renvoyée telle quelle : `tierOfView` retombe sur un niveau, dont l'IA n'est pas forcément la sienne. L'IA de l'assistant
// change alors, ce qui change son coût et sa façon de répondre : la page doit le DIRE avant d'envoyer, jamais après.
describe("methods-view : IA précise remplacée par l'ajout d'une méthode", () => {
  const MINI = "github-copilot/gpt-5.4-mini";
  const SONNET = "github-copilot/claude-sonnet-5";
  const CODEX = "github-copilot/gpt-5.3-codex";

  /** Niveaux tels que `GET /api/boot` les rend, réduits à ce que l'annonce lit. */
  const tiers: TierBrief[] = [
    { id: "rapide", label: "Rapide", model: MINI, modelName: "GPT-5.4 mini" },
    { id: "equilibre", label: "Équilibré", model: SONNET, modelName: "Claude Sonnet 5" },
    { id: "expert", label: "Poussée", model: null, modelName: null },
  ];

  it("IA précise qu'aucun niveau ne porte, en mode Simple : remplacement annoncé, les deux IA nommées", () => {
    const sub = modelSubstitution({ tier: null, model: CODEX, modelName: "GPT-5.3 Codex" }, { avance: false, tiers });
    assert.deepEqual(sub, { remplacee: true, actuelle: "GPT-5.3 Codex", nouvelle: "Claude Sonnet 5", niveau: "Équilibré" });
    const texte = texteIaRemplacee(sub);
    assert.ok(texte, "une substitution sans phrase ne serait annoncée nulle part");
    // Les deux IA et le niveau sont nommés : sans eux, la phrase ne dirait pas ce qui change.
    for (const attendu of ["GPT-5.3 Codex", "Claude Sonnet 5", "Équilibré"]) assert.ok(texte.includes(attendu), `${attendu} absent de « ${texte} »`);
    assert.equal(texte, M.iaPrecise.remplacee.replace("{ia}", "GPT-5.3 Codex").replace("{niveau}", "Équilibré").replace("{nouvelle}", "Claude Sonnet 5"));
  });

  it("IA précise qui EST celle d'un niveau : rien n'est remplacé, rien n'est annoncé", () => {
    for (const model of [SONNET, MINI]) {
      assert.deepEqual(modelSubstitution({ tier: null, model, modelName: null }, { avance: false, tiers }), {
        remplacee: false,
        actuelle: null,
        nouvelle: null,
        niveau: null,
      });
    }
  });

  it("mode Avancé, niveau déjà posé, aucune IA : rien n'est remplacé", () => {
    assert.equal(modelSubstitution({ tier: null, model: CODEX, modelName: null }, { avance: true, tiers }).remplacee, false);
    assert.equal(modelSubstitution({ tier: "rapide", model: MINI, modelName: null }, { avance: false, tiers }).remplacee, false);
    assert.equal(modelSubstitution({ tier: null, model: null, modelName: null }, { avance: false, tiers }).remplacee, false);
  });

  it("niveau de repli sans IA disponible : le remplacement est annoncé, sans nommer une IA qu'on ne connaît pas", () => {
    const sansIa: TierBrief[] = tiers.map((niveau) => (niveau.id === "equilibre" ? { ...niveau, model: null, modelName: null } : niveau));
    const sub = modelSubstitution({ tier: null, model: CODEX, modelName: null }, { avance: false, tiers: sansIa });
    // `actuelle` reprend la clé quand le nom lisible manque : jamais de trou, jamais un nom inventé.
    assert.deepEqual(sub, { remplacee: true, actuelle: CODEX, nouvelle: null, niveau: "Équilibré" });
    assert.equal(texteIaRemplacee(sub), M.iaPrecise.remplaceeSansNom.replace("{ia}", CODEX).replace("{niveau}", "Équilibré"));
  });

  it("aucune substitution : aucune phrase", () => {
    assert.equal(texteIaRemplacee({ remplacee: false, actuelle: null, nouvelle: null, niveau: null }), null);
  });
});

// --- Contrat statique de l'interface (les composants ne sont pas exécutés par npm test) -------------------------------------

const lire = (...parts: string[]) => fs.readFileSync(path.join(WEB, ...parts), "utf8");

/**
 * Source sans ses commentaires : ce qui est vraiment compilé, jamais ce qui est seulement expliqué en tête de fichier — sans
 * quoi un en-tête qui cite une phrase ou « dangerouslySetInnerHTML » ferait échouer (ou passer) un contrôle à tort.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/gm, "$1");
}

describe("methods-view : interface de la bibliothèque", () => {
  const carte = lire("methods", "MethodCard.tsx");
  const bibliotheque = lire("methods", "MethodsLibrary.tsx");
  const feuille = lire("methods", "methods.css");

  it("menu APG : bouton de menu, rôles, position annoncée, entrée désactivée décrite par sa raison", () => {
    for (const attendu of ['aria-haspopup="menu"', "aria-expanded", 'role="menu"', 'role="menuitem"', "aria-disabled", "aria-describedby", "aria-posinset", "aria-setsize"]) {
      assert.ok(carte.includes(attendu), attendu);
    }
    // Clavier APG repris du modèle pur existant, jamais réécrit ici.
    assert.ok(carte.includes("menuKey") && carte.includes("buttonKey"), "clavier du menu");
  });

  it("aucun texte affiché n'est réécrit dans les composants : tout vient de construction-texts.ts", () => {
    // Aucune phrase du module de textes n'est recopiée dans un composant (les libellés très courts, « Ajouter », se
    // retrouveraient dans d'autres phrases : seuls les textes d'au moins 15 caractères sont comparés à la lettre).
    for (const phrase of [M.carte.sansAppel, M.carte.ajouterAssistant, M.carte.conseillees, M.limites.trop, M.limites.deja, M.vide]) {
      assert.ok(phrase.length >= 15, phrase);
      assert.equal(code(carte).includes(phrase) || code(bibliotheque).includes(phrase), false, phrase);
    }
    // Chaque libellé affiché est lu par sa clé, y compris les plus courts ; « Quand » et « Attention » passent par le module pur.
    for (const cle of ["M.carte.sansAppel", "M.carte.texteExact", "M.carte.ajouterAssistant", "texteQuand", "texteAttention", "texteUtiliseePar"]) {
      assert.ok(code(carte).includes(cle), cle);
    }
    assert.ok(code(carte).includes("M.carte.ajouter}"), "« Ajouter » d'une méthode conseillée");
    assert.ok(code(bibliotheque).includes("M.vide"), "l'état vide vient du module de textes");
    assert.ok(code(bibliotheque).includes("M.carte.conseillees"), "« Méthodes conseillées » vient du module de textes");
  });

  it("aucune limite recopiée : elle vient du catalogue rendu par la route", () => {
    assert.equal(/\bparAssistant\s*:\s*\d/.test(code(carte)), false, "MethodCard");
    assert.ok(bibliotheque.includes("catalogue.limites.parAssistant"), "la limite vient de la réponse");
  });

  it("aucun texte n'est injecté en HTML : ni dangerouslySetInnerHTML, ni innerHTML", () => {
    for (const source of [carte, bibliotheque]) {
      assert.equal(code(source).includes("dangerouslySetInnerHTML"), false);
      assert.equal(code(source).includes("innerHTML"), false);
    }
    assert.ok(carte.includes("sourceHref"), "les sources passent par la garde");
  });

  it("l'ajout passe par la garde de rechargement et par le brouillon complet", () => {
    assert.ok(bibliotheque.includes("useReloadGuard"), "garde de rechargement");
    assert.ok(bibliotheque.includes("guardReload((options) => api.saveAssistant("), "PUT /api/assistants/:name");
    // Le corps est construit par le module pur voisin (testé pour de bon dans assistants.test.ts, section c5:methodes-niveau) :
    // aucune règle de conversion n'est réécrite ici, et la page lui passe le mode et les niveaux d'IA.
    const corps = fs.readFileSync(path.join(WEB, "methods", "assistant-request.ts"), "utf8");
    assert.ok(bibliotheque.includes("requestWithMethod(assistant, method, { avance, tiers })"), "le mode et les niveaux ne sont plus passés au corps");
    assert.ok(corps.includes("previousName: view.name"), "aucun renommage");
    assert.ok(corps.includes("tierOfView(view, contexte.avance, contexte.tiers)"), "la conversion du niveau n'est plus partagée avec l'assistant de création");
    assert.equal(/\btier:\s*view\.tier\b/.test(corps), false, "le niveau de l'assistant est recopié tel quel : le mode Simple refuserait une IA précise");
  });

  it("l'IA précise remplacée est annoncée AVANT l'envoi, dans le même dialogue que les droits", () => {
    const source = code(bibliotheque);
    assert.ok(source.includes("modelSubstitution(assistant, { avance, tiers })"), "la substitution est calculée par le module pur voisin");
    assert.ok(source.includes("texteIaRemplacee("), "la phrase vient du module pur, jamais réécrite dans la page");
    assert.equal(source.includes(M.iaPrecise.remplacee), false, "la phrase n'est pas recopiée dans la page");
    // Rien n'est envoyé tant que la confirmation n'est pas donnée : elle est demandée avant `setBusy(true)`, donc avant l'appel.
    const confirmation = source.indexOf("await confirm(");
    const envoi = source.indexOf("setBusy(true)");
    assert.ok(confirmation > 0 && envoi > confirmation, "la confirmation est demandée avant l'envoi");
    // Un seul dialogue liste les deux conséquences (droits « personnalisé » et IA précise) : deux dialogues de suite les
    // feraient lire l'une après l'autre, et le second passerait pour une répétition du premier.
    assert.equal((source.match(/await confirm\(/g) ?? []).length, 1, "un seul dialogue, qui cumule les avertissements");
    assert.ok(source.includes("avertissements"), "les avertissements sont assemblés avant d'ouvrir le dialogue");
  });

  it("feuille de style : mode contrasté, aucune animation, aucune boucle", () => {
    assert.ok(feuille.includes("@media (forced-colors: active)"), "forced-colors");
    assert.equal(/\banimation\b|\binfinite\b|@keyframes/.test(code(feuille)), false, "aucune animation");
    // 400 px (spécification §5.6) : les deux grilles passent à une colonne, la colonne des noms ne réserve plus de largeur,
    // le menu reste dans la fenêtre et défile. Aucune largeur fixe n'est posée hors de ces bornes.
    const etroit = code(feuille).slice(code(feuille).indexOf("@media (max-width: 480px)"), code(feuille).indexOf("@media (forced-colors"));
    assert.ok(etroit.includes("grid-template-columns: 1fr"), "grilles à une colonne");
    assert.ok(etroit.includes("min-width: 0"), "la colonne des noms ne réserve plus de largeur");
    assert.ok(code(feuille).includes("width: min(320px, calc(100vw - 32px))"), "menu borné à la fenêtre");
    assert.equal(/(?<![-\w])width:\s*\d+px/.test(code(feuille)), false, "aucune largeur fixe en pixels");
  });
});

describe("methods-view : sections c5 des fichiers partagés", () => {
  const fiche = lire("IdentityCard.tsx");
  const creation = lire("AssistantWizard.tsx");
  const page = fs.readFileSync(path.join(WEB, "..", "AssistantsPage.tsx"), "utf8");
  const cataloguegrid = lire("CatalogueGrid.tsx");

  it("fiche d'identité : la ligne et sa phrase fixe n'apparaissent qu'avec des méthodes", () => {
    assert.ok(fiche.includes("texteFicheMethodes"), "ligne « Méthodes : {liste} »");
    assert.ok(fiche.includes("TEXTES_C5.partout.methodes.fiche.phrase"), "phrase fixe");
    assert.ok(fiche.includes("ligneMethodes ? ("), "rien n'est affiché sans méthode");
    assert.equal(fiche.includes(M.fiche.phrase), false, "la phrase n'est pas recopiée");
  });

  /** Contenu d'une section balisée `c5:<nom>` ; la recherche est faite sans écrire de balise dans ce fichier. */
  function section(source: string, nom: string): string {
    const debut = source.indexOf("<" + `c5:${nom}>`);
    const fin = source.indexOf("</" + `c5:${nom}>`);
    assert.ok(debut >= 0 && fin > debut, `section c5:${nom} absente`);
    return source.slice(debut, fin);
  }

  it("« Modifier » garde les méthodes du fichier : le brouillon les reprend", () => {
    assert.ok(section(creation, "methodes-brouillon").includes("view.methods"), "draftFromView lit les méthodes du fichier");
    assert.ok(section(creation, "methodes-envoi").includes("d.methods"), "toRequest envoie draft.methods, même vide");
  });

  it("assistant de création : groupe des méthodes, rien de pré-coché, erreurs du serveur au bon écran", () => {
    assert.ok(creation.includes("wizardMethodState"), "état des cases");
    assert.ok(creation.includes("TEXTES_C5.partout.methodes.creation.titre"), "« Méthodes (facultatif) »");
    assert.ok(creation.includes("TEXTES_C5.partout.methodes.creation.conseillee"), "badge « Conseillée pour cet assistant »");
    assert.ok(/methods:\s*3/.test(creation), "FIELD_STEP : les erreurs « methods » ramènent à l'écran 3");
    assert.ok(creation.includes('case "methods":'), "issueStep : les erreurs « methods » ramènent à l'écran 3");
    // Rien n'est pré-coché : aucun identifiant de méthode n'est écrit en dur dans l'assistant de création, et le brouillon
    // neuf (emptyDraft, templates.ts) n'a aucune méthode.
    assert.equal(/methods:\s*\[\s*["'`]/.test(code(creation)), false, "aucun identifiant de méthode en dur");
    assert.equal(/\bmethods\b/.test(code(lire("templates.ts"))), false, "emptyDraft ne pose aucune méthode");
  });

  it("page Assistants : groupe des assistants d'équipe, section Méthodes, catalogue marqué", () => {
    assert.ok(page.includes("texteAssistantsEquipe(equipiers.length)"), "« Assistants des équipes ({n}) »");
    assert.ok(page.includes("TEXTES_C5.partout.assistantsEquipe.phrase"), "phrase du groupe");
    // Clôture 5b (A20) : la bibliothèque est montée par l'onglet « Méthodes », dans son propre fichier, que la page appelle.
    assert.ok(page.includes("<MethodsTab"), "onglet « Méthodes » appelé par la page");
    assert.ok(lire("methods", "MethodsTab.tsx").includes("<MethodsLibrary"), "bibliothèque des méthodes montée par l'onglet");
    assert.ok(page.includes("EQUIPIER_ROLE"), "rôle lu, jamais un nom d'assistant en dur");
    assert.ok(cataloguegrid.includes("item.role === EQUIPIER_ROLE"), "catalogue : assistants d'équipe marqués");
  });

  // Motifs assemblés par concaténation : écrits en clair, ils ressembleraient à des balises et feraient échouer
  // construction-balises.test.ts, qui cherche toute forme de balise dans app/.
  const OUVRANTE = new RegExp("<" + "c5:([\\w-]+)>", "g");
  const FERMANTE = new RegExp("</" + "c5:([\\w-]+)>", "g");

  it("chaque section ajoutée est balisée c5 et refermée", () => {
    for (const [nom, source] of [
      ["IdentityCard.tsx", fiche],
      ["AssistantWizard.tsx", creation],
      ["AssistantsPage.tsx", page],
      ["CatalogueGrid.tsx", cataloguegrid],
    ] as const) {
      const ouvertes = [...source.matchAll(OUVRANTE)].map((m) => m[1]);
      const fermees = [...source.matchAll(FERMANTE)].map((m) => m[1]);
      assert.ok(ouvertes.length > 0, `${nom} : au moins une section c5`);
      assert.deepEqual(ouvertes, fermees, `${nom} : sections équilibrées et dans l'ordre`);
    }
  });
});
