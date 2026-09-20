// Tests de croisement du train 5a V0 (plan d'exécution it5 §2.4, §5.3 ; propriété de l'intégrateur) : T5a (contrats, valeurs,
// textes, câblage), L44a (méthodes et catalogue), L47a (chronologie) et L45a (assistants d'équipe), sur le câblage complet
// (modules « tous »), après la pose par l'intégrateur des lignes du §4.4 dans contracts-11.ts, wiring-11.ts et wiring-11.test.ts.
// Ce que la vague doit prouver ensemble, et qu'aucun paquet ne pouvait prouver seul (chacun a été écrit sans voir les autres) :
//   1. câblage : les quatre modules de la construction sont au bout de MODULE_ORDER, sans port neutre, et leurs squelettes
//      n'inscrivent RIEN tant que L44b, L44c, L46a et L47b ne sont pas livrés — donc aucune route de la construction n'existe
//      encore, ni avec « modules: [] » ni avec « tous » (GET /api/methods → 404) ; un couple hors de STEP_ORDER échoue toujours ;
//      integration.test.ts n'a pas été touché par la vague ;
//   2. contrats de T5a contre le code réel : MethodView reprend la forme rendue par shared/methods.ts, MethodsResponse.limites
//      reprend METHOD_LIMITS, qui vient désormais de construction-constants.ts (copie locale de L44a remplacée au train), et
//      ChronologieView du contrat est bien le type rendu par chronologie() sur les captures p1, p2, p6 et p7 ;
//   3. catalogues ensemble : suggereePour de chaque méthode ne cite que des assistants qui existent (6 de l'it1 + 4 de L45a),
//      chaque bloc du catalogue passe methodTextProblem, l'identifiant et le titre du « Relecteur critique » attendus par les
//      valeurs et les textes de T5a sont ceux de l'entrée de L45a, et la réponse à Q1 (IA par défaut « Rapide ») est tenue ;
//   4. report de MC5 (mesure hors dépôt de la vague) : MC5-1 tenue, donc AUCUN contrat de repli n'entre dans la construction —
//      SecondReadingEstimate.base garde ses quatre valeurs sans « reponse », et les textes n'ont pas de variante de repli.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CATALOGUE } from "./assistants-catalogue.ts";
import type { Cockpit11Module } from "./contracts-11.ts";
import { METHODS } from "./methods-catalogue.ts";
import { applyEvent, emptyActivity } from "./shared/activity.ts";
import {
  CHRONO_MAX_ROWS,
  EQUIPIER_ROLE,
  METHOD_BLOCK_MAX_CHARS,
  METHOD_BLOCK_MAX_WORDS,
  METHODS_PER_ASSISTANT,
  METHODS_PER_MESSAGE,
  METHODS_PER_STEP,
  SECOND_READING_CATALOG_ID,
} from "./shared/construction-constants.ts";
import { TEXTES } from "./shared/construction-texts.ts";
import type { ChronologieView, MethodsResponse, MethodView, SecondReadingEstimate } from "./shared/construction-types.ts";
import { chronologie } from "./shared/chronologie.ts";
import { type Method, METHOD_LIMITS, methodTextProblem } from "./shared/methods.ts";
import { startCockpit } from "./test-support/cockpit-harness.ts";
import { readCapture } from "./test-support/fake-opencode.ts";
import { buildCockpit11, MODULE_ORDER, MODULES, NEUTRAL_PORTS, STEP_ORDER } from "./wiring-11.ts";
import { CONSTRUCTION_HOOKS, CONSTRUCTION_MODULE_ORDER, CONSTRUCTION_MODULES, CONSTRUCTION_ROUTES } from "./wiring-construction.ts";

const SERVER_DIR = import.meta.dirname;
/** Racine des captures « ocgraph » (opencode 1.18.30), celle du Déroulé de l'itération 1. */
const ROOT = "ses_f618ff214ffevi6gfuGx6TvpTP";
const CAPTURES = [
  "p1-delegation-parallele.jsonl",
  "p2-commande-subtask.jsonl",
  "p6-arret-global.jsonl",
  "p7-autorisation-orpheline.jsonl",
] as const;

/** Assistants d'équipe apportés par L45a : L44a ne pouvait que les prévoir, ils sont ici lus dans le vrai catalogue. */
const EQUIPIERS = ["relecteur-critique", "synthese-rapport", "aiguilleur", "rediger-compte-rendu-incident"] as const;

const entree = (id: string) => {
  const trouvee = CATALOGUE.find((e) => e.id === id);
  assert.ok(trouvee, `assistant ${id} absent du catalogue`);
  return trouvee;
};

// --- 1. Câblage -------------------------------------------------------------------------------------------------------------

describe("croisement 5a V0 : câblage de la construction dans la 1.1", () => {
  it("les quatre modules sont au bout de MODULE_ORDER, présents dans MODULES, et n'ont aucun port neutre", () => {
    assert.deepEqual(MODULE_ORDER.slice(-CONSTRUCTION_MODULE_ORDER.length), [...CONSTRUCTION_MODULE_ORDER]);
    assert.deepEqual([...new Set(MODULE_ORDER)].length, MODULE_ORDER.length);
    for (const name of CONSTRUCTION_MODULE_ORDER) {
      assert.equal(MODULES[name].name, name, `MODULES.${name}`);
      assert.equal(MODULES[name], CONSTRUCTION_MODULES[name], `${name} : le module câblé est bien celui de wiring-construction`);
      // Aucun port nouveau (D-5-04) : la construction n'expose rien aux autres modules.
      assert.equal(Object.hasOwn(NEUTRAL_PORTS, name), false, `${name} ne doit pas avoir de port neutre`);
    }
    // Les couples et le crochet de wiring-construction.ts sont ceux que porte le câblage de la 1.1.
    assert.deepEqual(STEP_ORDER.routes.slice(-CONSTRUCTION_ROUTES.length), CONSTRUCTION_ROUTES.map((couple) => [...couple]));
    for (const module of CONSTRUCTION_HOOKS.beforeBilledSend) assert.ok(STEP_ORDER.hooks.beforeBilledSend.includes(module), module);
  });

  it("squelettes inertes : avec tous les modules réels, aucune inscription de la construction, et GET /api/methods → 404", async (t) => {
    const h = await startCockpit(t, { modules: "tous" });
    const wiring = h.cockpit.wiring;
    assert.deepEqual(wiring.modules, [...MODULE_ORDER]);
    const construction: readonly string[] = CONSTRUCTION_MODULE_ORDER;
    assert.deepEqual(
      wiring.registrations.filter((r) => construction.includes(r.module)),
      [],
      "un squelette de T5a inscrit quelque chose : L44b, L44c, L46a et L47b ne sont pas encore livrés",
    );
    // Les six adresses du client d'API de T5a n'existent pas encore : la V0 ne livre aucun comportement.
    for (const adresse of [
      "/api/methods",
      `/api/conversations/${ROOT}/chronologie`,
      "/api/team-costs?mois=2026-09",
      `/api/conversations/${ROOT}/equipes`,
      "/api/conversations/equipes",
    ]) {
      const res = await h.call("GET", adresse, { headers: h.headers.authed });
      assert.equal(res.status, 404, `${adresse} → ${res.status}`);
    }
    h.assertNoGlobalRestart();
  });

  it("sans les modules (comportement de l'it1) : GET /api/methods → 404", async (t) => {
    const h = await startCockpit(t, { modules: [] });
    const res = await h.call("GET", "/api/methods", { headers: h.headers.authed });
    assert.equal(res.status, 404);
  });

  it("couple hors de STEP_ORDER : le câblage échoue, y compris pour un module de la construction", async (t) => {
    const h = await startCockpit(t, { modules: [] });
    const refuses: Cockpit11Module[] = [
      { name: "chronologie", install: (reg) => reg.routes("activity", () => undefined) },
      { name: "methods", install: (reg) => reg.routes("plans", () => undefined) },
      { name: "teamCosts", install: (reg) => reg.hook("beforeBilledSend", async () => null) },
    ];
    for (const module of refuses) {
      assert.throws(() => buildCockpit11(h.cockpit.c11, { modules: [module] }), /couple non prévu dans STEP_ORDER/, module.name);
    }
    // Le couple prévu, lui, passe : la table du §4.4 est bien celle que le registre attend.
    assert.doesNotThrow(() => buildCockpit11(h.cockpit.c11, { modules: [{ name: "methods", install: (reg) => reg.routes("construction", () => undefined) }] }));
  });

  it("integration.test.ts n'a pas été touché par la vague : ni balise c5:, ni nom de la construction", () => {
    const source = fs.readFileSync(path.join(SERVER_DIR, "integration.test.ts"), "utf8");
    assert.equal(source.includes("c5:"), false);
    for (const nom of [...CONSTRUCTION_MODULE_ORDER, "construction-", "api/methods"]) {
      assert.equal(source.includes(nom), false, `integration.test.ts cite « ${nom} »`);
    }
  });
});

// --- 2. Contrats de T5a contre le code réel ---------------------------------------------------------------------------------

describe("croisement 5a V0 : les contrats de T5a sont ceux du code livré", () => {
  it("MethodView reprend la forme rendue par shared/methods.ts : mêmes champs, plus les deux listes de l'interface", () => {
    const source = METHODS[0];
    assert.ok(source, "catalogue des méthodes vide");
    // La vue est construite ici comme la route de L44b la construira : la méthode telle quelle, moins `suggereePour`, qui
    // devient `conseilleePour` (avec « déjà attachée ? »), plus les assistants qui l'utilisent vraiment.
    const { suggereePour, ...reste } = source;
    const vue: MethodView = {
      ...reste,
      utiliseePar: [],
      conseilleePour: suggereePour.map((id) => ({ name: id, title: entree(id).title, attachee: false })),
    };
    assert.deepEqual(
      Object.keys(vue).sort(),
      ["attention", "bloc", "conseilleePour", "enTete", "id", "kind", "phrase", "quand", "sources", "titre", "version", "utiliseePar"].sort(),
    );
    const champsDeMethode = Object.keys(source).filter((clef) => clef !== "suggereePour");
    for (const clef of champsDeMethode) {
      assert.ok(Object.hasOwn(vue, clef), `MethodView n'a pas le champ « ${clef} » de Method`);
      assert.deepEqual(vue[clef as keyof MethodView], source[clef as keyof Method], clef);
    }
  });

  it("MethodsResponse.limites = METHOD_LIMITS, qui vient de construction-constants.ts (copie locale de L44a remplacée au train)", () => {
    const limites: MethodsResponse["limites"] = {
      parAssistant: METHOD_LIMITS.parAssistant,
      parMessage: METHOD_LIMITS.parMessage,
      parEtape: METHOD_LIMITS.parEtape,
    };
    assert.deepEqual(limites, { parAssistant: METHODS_PER_ASSISTANT, parMessage: METHODS_PER_MESSAGE, parEtape: METHODS_PER_STEP });
    assert.equal(METHOD_LIMITS.blocMaxCaracteres, METHOD_BLOCK_MAX_CHARS);
    assert.equal(METHOD_LIMITS.blocMaxMots, METHOD_BLOCK_MAX_WORDS);
    // Les valeurs ne sont plus recopiées : une seule source, celle de T5a.
    const source = fs.readFileSync(path.join(SERVER_DIR, "shared", "methods.ts"), "utf8");
    assert.ok(source.includes('from "./construction-constants.ts"'), "shared/methods.ts n'importe pas les limites");
    assert.equal(/^const METHODS_PER_/m.test(source), false, "une copie locale des limites est revenue dans shared/methods.ts");
  });

  it("ChronologieView du contrat est le type rendu par chronologie() : captures p1, p2, p6 et p7 relues sans exception", () => {
    for (const capture of CAPTURES) {
      let state = emptyActivity(ROOT);
      let now = 0;
      for (const { recv, wire } of readCapture(capture)) {
        now = Math.max(now, recv);
        state = applyEvent(state, { kind: "opencode", event: wire.payload as never });
      }
      // Le type est celui de T5a, pas celui de L47a : la ligne ne compile que si les deux disent la même chose.
      const vue: ChronologieView = chronologie(state, [], now + 1_000);
      assert.ok(Array.isArray(vue.rows) && Array.isArray(vue.groupes), capture);
      assert.equal(typeof vue.partiel, "boolean", capture);
      for (const ligne of vue.rows) {
        assert.equal(typeof ligne.key, "string", capture);
        for (const appel of ligne.calls) {
          // Honnêteté : sans ligne `usage`, les jetons et l'IA sont « non enregistrés », jamais 0 ni un nom inventé.
          assert.equal(appel.tokensIn, null, `${capture} / ${appel.messageId}`);
          assert.equal(appel.tokensOut, null, `${capture} / ${appel.messageId}`);
          assert.equal(appel.model, null, `${capture} / ${appel.messageId}`);
        }
      }
      // Bornes cohérentes quand elles existent (une conversation sans aucune ligne les laisse à null).
      if (vue.start !== null && vue.end !== null) assert.ok(vue.end >= vue.start, capture);
    }
    // La borne de troncature appartient à la route (L47b) : le module pur ne la lit pas.
    assert.equal(typeof CHRONO_MAX_ROWS, "number");
  });
});

// --- 3. Catalogues ensemble -------------------------------------------------------------------------------------------------

describe("croisement 5a V0 : méthodes et assistants dans le même catalogue", () => {
  it("suggereePour ne cite que des assistants qui existent (6 de l'it1 + 4 de L45a)", () => {
    const connus = new Set(CATALOGUE.map((e) => e.id));
    assert.equal(CATALOGUE.length, 10, "le catalogue doit porter les 6 assistants de l'it1 et les 4 de L45a");
    for (const equipier of EQUIPIERS) assert.ok(connus.has(equipier), `${equipier} absent du catalogue`);
    for (const methode of METHODS) {
      for (const id of methode.suggereePour) assert.ok(connus.has(id), `méthode ${methode.id} : assistant inconnu « ${id} »`);
    }
    // Au moins une méthode conseille un assistant de L45a : sans le croisement, personne ne le vérifiait.
    assert.ok(METHODS.some((m) => m.suggereePour.some((id) => (EQUIPIERS as readonly string[]).includes(id))));
  });

  it("chaque bloc du catalogue des méthodes passe methodTextProblem", () => {
    for (const methode of METHODS) assert.equal(methodTextProblem(methode), null, `${methode.id} : ${methodTextProblem(methode)}`);
  });

  it("le « Relecteur critique » attendu par les valeurs et les textes de T5a est celui de L45a, avec l'IA de Q1", () => {
    const relecteur = entree(SECOND_READING_CATALOG_ID);
    // Q1 (a), décision A11 : IA par défaut « Rapide ». Le choix reste modifiable comme pour tout assistant.
    assert.equal(relecteur.tier, "rapide");
    assert.equal(relecteur.role, EQUIPIER_ROLE);
    // Le titre cité par la phrase de refus de T5a est celui de l'entrée : un renommage de L45a casserait le texte.
    assert.ok(
      TEXTES.partout.erreurs["seconde-lecture-absente"].includes(`« ${relecteur.title} »`),
      `la phrase de refus ne cite pas « ${relecteur.title} »`,
    );
    for (const equipier of EQUIPIERS) {
      const e = entree(equipier);
      assert.equal(e.role, EQUIPIER_ROLE, equipier);
      // Grille de la vague 0 : assistants d'équipe en lecture seule et sans Internet.
      assert.equal(e.rights, "lecture", equipier);
      assert.equal(e.web, false, equipier);
    }
  });
});

// --- 4. Report de la mesure MC5 ---------------------------------------------------------------------------------------------

describe("croisement 5a V0 : report de MC5 (mesure hors dépôt de la vague)", () => {
  it("MC5-1 tenue : aucun contrat de repli n'entre dans la construction", () => {
    // MC5-1 (deux passes identiques) : un envoi avec un autre assistant et une autre IA, dans la MÊME session, reçoit tout
    // l'historique et la seule invite système du relecteur. La voie principale de L44c et L44e est donc fondée, et la base
    // d'estimation « conversation » de D-5-22 tient. Un repli aurait ajouté la valeur « reponse » et ses textes : elle n'existe pas.
    const bases: Array<SecondReadingEstimate["base"]> = ["conversation", "observe", "profil", "aucune"];
    assert.deepEqual(Object.keys(TEXTES.partout.secondeLecture.base).sort(), ["conversation", "observe", "profil"]);
    for (const base of bases) {
      if (base === "aucune") continue;
      const phrase = TEXTES.partout.secondeLecture.base[base as "conversation" | "observe" | "profil"];
      assert.ok(phrase.length > 0 && !phrase.includes("au moins"), base);
    }
    // La marque d'un repli serait la base « reponse » (relire la seule réponse, hors de la conversation) et sa phrase.
    const types = fs.readFileSync(path.join(SERVER_DIR, "shared", "construction-types.ts"), "utf8");
    assert.equal(/base:\s*"conversation" \| "observe" \| "profil" \| "aucune"/.test(types.replace(/\s+/g, " ")), true);
    assert.equal(Object.hasOwn(TEXTES.partout.secondeLecture.base, "reponse"), false);
    // Phrase de L50a fondée par MC5-1 : le relecteur voit bien toute la conversation, le coût suit sa longueur.
    const toutesLesPhrases = JSON.stringify(TEXTES);
    assert.ok(toutesLesPhrases.includes("Il voit toute la conversation"), "la phrase d'honnêteté de la Seconde lecture a disparu");
  });
});
