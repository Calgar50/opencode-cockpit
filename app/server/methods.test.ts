// Méthodes : module pur et catalogue (plan d'exécution it5, fiche L44a ; D-5-07, D-5-08 ; conception C §5.4 et §12.2 ; RM §5.7).
// Couvre : insertion, retrait et remplacement idempotents des blocs d'un fichier d'agent, jamais de doublon, 2 au plus ;
// aller-retour du bloc ajouté à un message ; détection de l'en-tête (casse, accents, jamais au milieu d'une ligne) ; contrôle
// du texte de chaque méthode ; une méthode « relecture » jamais rendue en bloc ; identifiants uniques ; méthodes conseillées à
// des assistants qui existent ; mots interdits absents des textes affichés ; pureté du module partagé.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CATALOGUE } from "./assistants-catalogue.ts";
import { METHODS } from "./methods-catalogue.ts";
import { assistantBody, COMMON_RULES_START } from "./shared/assistant-rules.ts";
import {
  applyMethodBlocks,
  type Method,
  METHOD_LIMITS,
  methodDetected,
  methodIdsIn,
  methodMarkers,
  methodTextProblem,
  PHRASE_SINON,
  renderMessageMethodBlock,
  renderMethodBlock,
  splitMessageMethods,
  stripMethodBlocks,
} from "./shared/methods.ts";

/**
 * Assistants d'équipe annoncés par L45a, écrits ici : ils sont de la MÊME vague que ce paquet, donc absents de cette copie du
 * dépôt. L'inclusion stricte de `suggereePour` dans le vrai `CATALOGUE` (6 entrées + ces 4) est un croisement du train de V0.
 */
const EQUIPIERS_PREVUS = ["relecteur-critique", "synthese-rapport", "aiguilleur", "rediger-compte-rendu-incident"];

const methode = (id: string): Method => {
  const trouvee = METHODS.find((m) => m.id === id);
  if (trouvee === undefined) throw new Error(`méthode ${id} absente du catalogue`);
  return trouvee;
};

/** Modules importés par un fichier, dans l'ordre. */
const importsDe = (source: string): string[] => [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((trouve) => trouve[1] ?? "");

/** Méthode fabriquée pour éprouver une garde, sans toucher au catalogue. */
const fausse = (over: Partial<Method> = {}): Method => ({
  id: "essai",
  version: 1,
  titre: "Essai",
  phrase: "Phrase.",
  quand: "Quand.",
  attention: "Attention.",
  kind: "consigne",
  bloc: `Quand la demande porte sur un essai : commence ta réponse par « ### Méthode : Essai ».\n${PHRASE_SINON}`,
  enTete: "### Méthode : Essai",
  suggereePour: [],
  sources: [],
  ...over,
});

const preMortem = methode("pre-mortem");
const clarifier = methode("clarifier-d-abord");
const avocat = methode("avocat-du-diable");
const secondeLecture = methode("seconde-lecture");

describe("méthodes : blocs d'un fichier d'agent", () => {
  it("insère les blocs demandés, dans l'ordre, séparés d'une ligne vide", () => {
    const corps = applyMethodBlocks("Analyse les journaux.", [preMortem, clarifier]);
    assert.deepEqual(methodIdsIn(corps), [
      { id: "pre-mortem", version: preMortem.version },
      { id: "clarifier-d-abord", version: clarifier.version },
    ]);
    assert.ok(corps.startsWith("Analyse les journaux.\n\n"), corps);
    assert.ok(corps.includes(`${methodMarkers(preMortem.id, preMortem.version).fin}\n\n${methodMarkers(clarifier.id, clarifier.version).debut}`));
    assert.equal(corps.includes(`## Méthode : ${preMortem.titre} (ajoutée par le cockpit)`), true);
  });

  it("les blocs restent avant les règles communes, qui demeurent le dernier bloc du corps", () => {
    const corps = applyMethodBlocks(assistantBody("Analyse les journaux.", []), [preMortem]);
    const debutMethode = corps.indexOf(methodMarkers(preMortem.id, preMortem.version).debut);
    const debutCommunes = corps.indexOf(COMMON_RULES_START);
    assert.ok(debutMethode > 0 && debutCommunes > debutMethode, corps);
    assert.equal(corps.includes("Analyse les journaux."), true);
  });

  it("est idempotent : appliquer deux fois les mêmes méthodes rend le même corps", () => {
    const une = applyMethodBlocks(assistantBody("Consignes.", []), [preMortem, clarifier]);
    assert.equal(applyMethodBlocks(une, [preMortem, clarifier]), une);
  });

  it("remplace : les anciennes méthodes partent, seules les nouvelles restent", () => {
    const avant = applyMethodBlocks("Consignes.", [preMortem, clarifier]);
    const apres = applyMethodBlocks(avant, [avocat]);
    assert.deepEqual(methodIdsIn(apres), [{ id: "avocat-du-diable", version: avocat.version }]);
    assert.equal(apres.includes(preMortem.enTete), false);
    assert.equal(apres.includes(`## Méthode : ${clarifier.titre} (ajoutée par le cockpit)`), false);
  });

  it("retire tout : le corps revient aux seules consignes", () => {
    const corps = applyMethodBlocks("Consignes.", [preMortem, clarifier]);
    assert.equal(applyMethodBlocks(corps, []), "Consignes.");
    assert.equal(stripMethodBlocks(corps), "Consignes.");
    assert.deepEqual(methodIdsIn(applyMethodBlocks(corps, [])), []);
  });

  it("jamais de doublon : la même méthode donnée deux fois ne pose qu'un bloc", () => {
    const corps = applyMethodBlocks("Consignes.", [preMortem, preMortem]);
    assert.deepEqual(methodIdsIn(corps), [{ id: "pre-mortem", version: preMortem.version }]);
  });

  it("une version plus récente remplace l'ancienne, sans laisser le bloc précédent", () => {
    const ancien = applyMethodBlocks("Consignes.", [{ ...preMortem, version: 1, bloc: "Ancien texte." }]);
    const neuf = applyMethodBlocks(ancien, [{ ...preMortem, version: 2 }]);
    assert.deepEqual(methodIdsIn(neuf), [{ id: "pre-mortem", version: 2 }]);
    assert.equal(neuf.includes("Ancien texte."), false);
  });

  it("2 au plus : les limites sont celles du plan (§4.2), copie locale de construction-constants.ts", () => {
    assert.deepEqual({ ...METHOD_LIMITS }, { parAssistant: 2, parMessage: 2, parEtape: 2, blocMaxCaracteres: 900, blocMaxMots: 120 });
    const corps = applyMethodBlocks("Consignes.", [preMortem, clarifier]);
    assert.equal(methodIdsIn(corps).length, METHOD_LIMITS.parAssistant);
  });

  it("marqueurs et en-tête orphelins retirés, comme stripCommonRules", () => {
    const abime = [
      "Consignes.",
      "",
      "<!-- cockpit:methode pre-mortem v1 -->",
      "## Méthode : Pré-mortem (ajoutée par le cockpit)",
      "Texte resté sans fin de bloc.",
      "",
      "<!-- /cockpit:methode -->",
      "",
      "## Méthode : Autre (ajoutée par le cockpit)",
      "",
      "Fin des consignes.",
    ].join("\n");
    const propre = stripMethodBlocks(abime);
    assert.equal(propre.includes("cockpit:methode"), false, propre);
    assert.equal(propre.includes("(ajoutée par le cockpit)"), false, propre);
    assert.equal(propre, "Consignes.\n\nFin des consignes.");
  });

  it("un marqueur de début sans fin ne compte pas comme une méthode présente", () => {
    assert.deepEqual(methodIdsIn("Consignes.\n<!-- cockpit:methode pre-mortem v1 -->\nTexte."), []);
  });

  it("fins de ligne Windows : le corps relu donne les mêmes identifiants", () => {
    const corps = applyMethodBlocks("Consignes.", [preMortem]);
    assert.deepEqual(methodIdsIn(corps.replace(/\n/g, "\r\n")), [{ id: "pre-mortem", version: preMortem.version }]);
  });

  it("une méthode « relecture » n'est jamais rendue en bloc", () => {
    assert.equal(secondeLecture.kind, "relecture");
    assert.equal(secondeLecture.bloc, "");
    assert.equal(renderMethodBlock(secondeLecture), "");
    assert.equal(renderMessageMethodBlock(secondeLecture), "");
    const corps = applyMethodBlocks("Consignes.", [secondeLecture]);
    assert.equal(corps, "Consignes.");
    assert.deepEqual(methodIdsIn(corps), []);
  });

  it("c'est le genre qui décide : une méthode « relecture » porteuse d'un texte n'est toujours pas un bloc", () => {
    const bavarde = fausse({ id: "relecture-bavarde", kind: "relecture", bloc: "Relis la réponse précédente." });
    assert.equal(renderMethodBlock(bavarde), "");
    assert.equal(renderMessageMethodBlock(bavarde), "");
    assert.equal(applyMethodBlocks("Consignes.", [bavarde]), "Consignes.");
  });
});

describe("méthodes : bloc ajouté à un message", () => {
  it("aller-retour : le texte de l'utilisateur et la méthode sont retrouvés à l'identique", () => {
    const texte = "Prépare la bascule de vendredi.";
    const envoye = texte + renderMessageMethodBlock(preMortem);
    assert.equal(envoye.includes(`## Méthode demandée : ${preMortem.titre}`), true);
    assert.deepEqual(splitMessageMethods(envoye), {
      texte,
      methodes: [{ id: "pre-mortem", version: preMortem.version, bloc: preMortem.bloc }],
    });
  });

  it("deux méthodes ajoutées : les deux blocs sont séparés du texte, dans l'ordre", () => {
    const texte = "Relis ce script.";
    const envoye = texte + renderMessageMethodBlock(preMortem) + renderMessageMethodBlock(clarifier);
    const { texte: reste, methodes } = splitMessageMethods(envoye);
    assert.equal(reste, texte);
    assert.deepEqual(
      methodes.map((m) => m.id),
      ["pre-mortem", "clarifier-d-abord"],
    );
    assert.equal(methodes.length, METHOD_LIMITS.parMessage);
  });

  it("un message sans méthode reste tel quel", () => {
    assert.deepEqual(splitMessageMethods("Bonjour."), { texte: "Bonjour.", methodes: [] });
  });
});

describe("méthodes : détection de l'en-tête dans la réponse", () => {
  it("positif : en-tête en début de ligne", () => {
    assert.equal(methodDetected(`Voici.\n\n${preMortem.enTete}\n\n1. ...`, preMortem), true);
  });

  it("positif : casse et accents tolérés", () => {
    assert.equal(methodDetected("### METHODE : PRE-MORTEM", preMortem), true);
    assert.equal(methodDetected("### methode : pre-mortem\nsuite", preMortem), true);
  });

  it("négatif : en-tête au milieu d'une ligne", () => {
    assert.equal(methodDetected("Comme demandé ### Méthode : Pré-mortem plus bas.", preMortem), false);
  });

  it("négatif : aucune section, ou la section d'une autre méthode", () => {
    assert.equal(methodDetected("Voici mon analyse du plan.", preMortem), false);
    assert.equal(methodDetected(clarifier.enTete, preMortem), false);
  });

  it("la détection ne dit rien de la qualité : un en-tête seul suffit (spéc. §6 l.1051)", () => {
    assert.equal(methodDetected(preMortem.enTete, preMortem), true);
  });
});

describe("méthodes : contrôle du texte", () => {
  it("chaque méthode « consigne » du catalogue passe le contrôle", () => {
    for (const m of METHODS) assert.equal(methodTextProblem(m), null, m.id);
  });

  it("interdit : exécution de commande, référence de fichier, arguments d'un raccourci", () => {
    for (const morceau of ["!`hostname`", "@dossier/fichier.md", "$ARGUMENTS"]) {
      assert.equal(methodTextProblem(fausse({ bloc: `Commence ta réponse par « ### Méthode : Essai ». ${morceau}\n${PHRASE_SINON}` })), "interdit", morceau);
    }
  });

  it("trop-long : au-delà de 900 caractères ou de 120 mots", () => {
    const long = `Commence ta réponse par « ### Méthode : Essai ». ${"détail ".repeat(200)}\n${PHRASE_SINON}`;
    assert.ok(long.length > METHOD_LIMITS.blocMaxCaracteres);
    assert.equal(methodTextProblem(fausse({ bloc: long })), "trop-long");
    const bavard = `Commence ta réponse par « ### Méthode : Essai ». ${"mot ".repeat(125)}\n${PHRASE_SINON}`;
    assert.ok(bavard.length <= METHOD_LIMITS.blocMaxCaracteres, String(bavard.length));
    assert.equal(methodTextProblem(fausse({ bloc: bavard })), "trop-long");
  });

  it("sans-en-tete : le bloc ne demande pas de commencer par l'en-tête", () => {
    assert.equal(methodTextProblem(fausse({ bloc: `Fais de ton mieux.\n${PHRASE_SINON}` })), "sans-en-tete");
  });

  it("sans-sinon : la dernière phrase n'est pas celle qui borne la méthode", () => {
    assert.equal(methodTextProblem(fausse({ bloc: "Commence ta réponse par « ### Méthode : Essai ». Applique-la toujours." })), "sans-sinon");
    assert.equal(PHRASE_SINON, "Sinon, n'applique pas cette méthode.");
  });

  it("« certitude » est la seule méthode de base : elle s'applique toujours, sans phrase « Sinon »", () => {
    assert.equal(methodTextProblem(fausse({ id: "certitude", bloc: "Commence ta réponse par « ### Méthode : Essai ». Applique-la toujours." })), null);
    assert.equal(methode("certitude").bloc.includes(PHRASE_SINON), false);
  });

  it("une méthode « relecture » n'a pas de bloc à contrôler", () => {
    assert.equal(methodTextProblem(fausse({ kind: "relecture", bloc: "" })), null);
  });
});

describe("catalogue des méthodes", () => {
  it("huit méthodes, identifiants uniques, sept consignes et une relecture (C §12.2)", () => {
    assert.equal(METHODS.length, 8);
    assert.equal(new Set(METHODS.map((m) => m.id)).size, METHODS.length);
    assert.deepEqual(
      METHODS.map((m) => m.id),
      ["certitude", "clarifier-d-abord", "diagnostic-differentiel", "cinq-pourquoi", "pre-mortem", "retour-arriere-d-abord", "avocat-du-diable", "seconde-lecture"],
    );
    assert.equal(METHODS.filter((m) => m.kind === "consigne").length, 7);
    assert.deepEqual(METHODS.filter((m) => m.kind === "relecture").map((m) => m.id), ["seconde-lecture"]);
  });

  it("chaque entrée est complète : en-tête tiré du titre, phrase, quand et attention bornés, sources en liens", () => {
    for (const m of METHODS) {
      assert.equal(m.enTete, `### Méthode : ${m.titre}`, m.id);
      assert.ok(m.version >= 1, m.id);
      for (const [nom, valeur] of [["phrase", m.phrase], ["quand", m.quand], ["attention", m.attention]] as const) {
        assert.ok(valeur.trim().length > 0, `${m.id} : ${nom} vide`);
      }
      assert.ok(m.quand.length <= 200, `${m.id} : quand ${m.quand.length} caractères`);
      assert.ok(m.attention.length <= 200, `${m.id} : attention ${m.attention.length} caractères`);
      for (const source of m.sources) assert.ok(source.startsWith("https://"), `${m.id} : source ${source}`);
    }
  });

  it("chaque bloc commence par son déclencheur et tient dans les limites", () => {
    for (const m of METHODS.filter((entree) => entree.kind === "consigne")) {
      const premiere = m.bloc.split("\n")[0] ?? "";
      assert.ok(premiere.includes(`commence ta réponse par « ${m.enTete} »`), `${m.id} : première phrase « ${premiere} »`);
      assert.ok(m.bloc.length <= METHOD_LIMITS.blocMaxCaracteres, `${m.id} : ${m.bloc.length} caractères`);
      assert.ok(m.bloc.trim().split(/\s+/).length <= METHOD_LIMITS.blocMaxMots, `${m.id} : ${m.bloc.trim().split(/\s+/).length} mots`);
    }
  });

  it("aucune méthode n'est attachée automatiquement : elles sont seulement conseillées à des assistants qui existent", () => {
    const connus = new Set([...CATALOGUE.map((entree) => entree.id), ...EQUIPIERS_PREVUS]);
    for (const m of METHODS) {
      for (const id of m.suggereePour) assert.ok(connus.has(id), `${m.id} : assistant inconnu ${id}`);
      assert.equal(new Set(m.suggereePour).size, m.suggereePour.length, `${m.id} : assistant conseillé deux fois`);
    }
    assert.deepEqual(methode("seconde-lecture").suggereePour, ["relecteur-critique"]);
    assert.deepEqual(methode("avocat-du-diable").suggereePour, []);
  });

  it("le catalogue est figé : aucune modification à chaud", () => {
    assert.equal(Object.isFrozen(METHODS), true);
    assert.throws(() => (METHODS as Method[]).push(fausse()));
  });
});

// Mêmes listes que le test « textes » (§2.2 et §2.3 de la spécification) : elles ne sont pas exportées par `textes.test.ts`, donc
// recopiées ici pour les textes AFFICHÉS du catalogue (titre, phrase, quand, attention). Le bloc, lui, part dans le fichier d'un
// assistant : il suit les règles communes, pas le vocabulaire de l'interface. Demande de contrat au train de V0 : exporter ces
// listes pour n'en avoir qu'une seule copie.
const LETTRE = "\\p{L}\\p{N}_";
const regle = (mot: string, motif: string) => ({ mot, re: new RegExp(`(?<![${LETTRE}-])(?:${motif})(?![${LETTRE}])`, "iu") });

const INTERDITS_SIMPLE = [
  regle("agent", "agents?"),
  regle("sous-agent", "sous-agents?"),
  regle("session", "sessions?"),
  regle("prompt", "prompts?"),
  regle("jeton", "jetons?"),
  regle("token", "tokens?"),
  regle("workflow", "workflows?"),
  regle("pipeline", "pipelines?"),
  regle("orchestrateur", "orchestrat(?:eur|rice)s?"),
  regle("nœud", "n(?:œ|oe)uds?"),
  regle("parallèle", "parall[èe]les?"),
  regle("boucle", "boucles?"),
  regle("itération", "it[ée]rations?"),
  regle("permission", "permissions?"),
  regle("juge", "juges?"),
  regle("classifieur", "classifi(?:eur|cateur)s?"),
  regle("LLM", "llms?"),
  regle("profondeur", "profondeurs?"),
  regle("subagent_depth", "subagent_depth"),
  regle("regard", "regards?"),
  regle("validé", "validée?s?"),
  regle("approuvé", "approuvée?s?"),
  regle("vérifié par l'IA", "vérifiée?s?\\s+par\\s+l['’]\\s*IA"),
  regle("feu vert", "feux?\\s+verts?"),
  regle("prêt pour le CAB", "prête?s?\\s+pour\\s+le\\s+CAB"),
];

const INTERDITS_PARTOUT = [
  regle("Toujours autoriser", "toujours\\s+autoriser"),
  regle("jamais plus de", "jamais\\s+plus\\s+de"),
  regle("sans risque", "sans\\s+risques?"),
  regle("tout autoriser", "tout\\s+autoriser"),
  regle("réussi", "réussie?s?"),
];

const BANNIS = [
  regle("Dossier transmis", "dossiers?\\s+transmis"),
  regle("chef d'équipe", "chefs?\\s+d['’]\\s*équipes?"),
  regle("validation", "validations?"),
  regle("modèle", "mod[èe]les?(?!\\s+de\\s+réflexion)"),
  regle("Réfléchit", "r[ée]fl[ée]chi(?:t|ssent)"),
];

describe("catalogue des méthodes : textes affichés", () => {
  it("aucun mot interdit en Simple, interdit partout ou banni", () => {
    for (const m of METHODS) {
      for (const [nom, texte] of [["titre", m.titre], ["phrase", m.phrase], ["quand", m.quand], ["attention", m.attention]] as const) {
        for (const { mot, re } of [...INTERDITS_SIMPLE, ...INTERDITS_PARTOUT, ...BANNIS]) {
          assert.equal(re.test(texte), false, `${m.id} · ${nom} : « ${mot} » dans « ${texte} »`);
        }
      }
    }
  });

  it("les listes recopiées mordent : un texte fautif serait refusé", () => {
    const fautifs = ["Le agent répond.", "Prêt pour le CAB.", "Changement sans risque.", "Le modèle choisi."];
    for (const texte of fautifs) {
      const touche = [...INTERDITS_SIMPLE, ...INTERDITS_PARTOUT, ...BANNIS].some(({ re }) => re.test(texte));
      assert.equal(touche, true, texte);
    }
  });
});

describe("méthodes : module partagé", () => {
  it("shared/methods.ts est pur : aucun import, aucun module node, aucun accès à process", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "shared", "methods.ts"), "utf8");
    assert.equal(source.includes('"node:'), false);
    assert.equal(/\bprocess\./.test(source), false);
    assert.equal(/\brequire\s*\(/.test(source), false);
    assert.deepEqual(importsDe(source), []);
  });

  it("le catalogue n'importe que le type Method : construction-constants.ts n'existe pas dans cette vague", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "methods-catalogue.ts"), "utf8");
    const partage = fs.readFileSync(path.join(import.meta.dirname, "shared", "methods.ts"), "utf8");
    assert.deepEqual(importsDe(source), ["./shared/methods.ts"]);
    for (const texte of [source, partage]) {
      assert.equal(
        importsDe(texte).some((spec) => spec.includes("construction-constants")),
        false,
      );
    }
  });
});
