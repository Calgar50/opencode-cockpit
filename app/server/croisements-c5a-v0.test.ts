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
import { EventMemory, type FactContext, FactDeduper, type FactEvent, type FactSession, factsFromEvent } from "./shared/activity-facts.ts";
import {
  CHRONO_MAX_ROWS,
  CONSTRUCTION_ROUTE_PATHS as CHEMINS,
  constructionPath,
  EQUIPIER_ROLE,
  METHOD_BLOCK_MAX_CHARS,
  METHOD_BLOCK_MAX_WORDS,
  METHODS_PER_ASSISTANT,
  METHODS_PER_MESSAGE,
  METHODS_PER_STEP,
  SECOND_READING_CATALOG_ID,
  TEAM_COSTS_MONTH_PARAM,
} from "./shared/construction-constants.ts";
import { TEXTES } from "./shared/construction-texts.ts";
import type { ChronologieUsageRow, ChronologieView, MethodsResponse, MethodView, SecondReadingEstimate } from "./shared/construction-types.ts";
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

const isRecord = (valeur: unknown): valeur is Record<string, unknown> =>
  typeof valeur === "object" && valeur !== null && !Array.isArray(valeur);

/**
 * Rejeu d'une capture par le CHEMIN DES FAITS, celui de la production (L4a, L4b) : sans lui, `timeline` ne rend ni appel ni
 * repère, et la chronologie n'aurait rien à montrer. Même montage que le test de L47a, repris ici pour que le croisement porte
 * sur le code fusionné.
 */
function rejouer(capture: string): { state: ReturnType<typeof emptyActivity>; now: number } {
  const sessions = new Map<string, FactSession>([[ROOT, { rootId: ROOT, parentId: null, purpose: "chat", instance: "principale" }]]);
  const memory = new EventMemory();
  const store = new FactDeduper();
  const resoudre = (id: string, info?: Readonly<Record<string, unknown>>): FactSession | null => {
    const connue = sessions.get(id);
    if (connue) return connue;
    const parentId = typeof info?.parentID === "string" ? info.parentID : null;
    const parent = parentId === null ? undefined : sessions.get(parentId);
    if (!info || info.id !== id || !parent) return null;
    return { rootId: parent.rootId, parentId, purpose: "chat", instance: parent.instance };
  };
  const ctx = (receivedAt: number): FactContext => ({
    receivedAt,
    session: (id, info) => resoudre(id, info),
    messageRole: (id) => memory.messageRole(id),
    promptKind: () => null,
    firstUserMessage: (id) => memory.firstUserMessage(id),
    userMessageParts: (id) => memory.userMessageParts(id),
    unansweredUserMessages: (id) => memory.unansweredUserMessages(id),
  });

  let state = emptyActivity(ROOT);
  let now = 0;
  for (const { recv, wire } of readCapture(capture)) {
    const event = wire.payload as FactEvent;
    now = Math.max(now, recv);
    memory.observe(event);
    const info = event.properties?.info;
    if ((event.type === "session.created" || event.type === "session.updated") && isRecord(info) && typeof info.id === "string") {
      const session = resoudre(info.id, info);
      if (session) sessions.set(info.id, session);
    }
    state = applyEvent(state, { kind: "opencode", event });
    for (const fait of factsFromEvent(event, ctx(recv)).filter((f) => store.accept(f))) {
      state = applyEvent(state, { kind: "cockpit", type: "activite.fait", data: fait });
    }
  }
  return { state, now: now + 1_000 };
}

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
    // Seconde lecture : un seul crochet, et le DERNIER de beforeBilledSend (D-5-06 : il ne requalifie que la ligne qu'enforceTurn
    // vient d'écrire). Une liste vide passerait une boucle sans rien prouver, d'où l'égalité.
    assert.deepEqual([...CONSTRUCTION_HOOKS.beforeBilledSend], ["secondReading"]);
    assert.equal(STEP_ORDER.hooks.beforeBilledSend.at(-1), "secondReading");
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
    // Les six adresses du client d'API de T5a n'existent pas encore : la V0 ne livre aucun comportement. Elles sont lues dans
    // CONSTRUCTION_ROUTE_PATHS, jamais recopiées ici : une adresse du client qui s'écarterait des fiches ferait tomber ce test
    // en même temps que celui du client, au lieu de traverser le train avec tout au vert.
    // Le corps attendu est le 404 GÉNÉRIQUE de `/api/*` (« Route inconnue. ») : il prouve qu'aucune route déjà montée par
    // http.ts ne capte l'adresse. C'est ce qui serait arrivé à `/api/archive/equipes`, avalé par `app.get("/api/archive/:id")`.
    const adresses: readonly [string, string][] = [
      ["GET", CHEMINS.methodes],
      ["POST", CHEMINS.secondeLectureEstimation],
      ["GET", constructionPath(CHEMINS.chronologie, ROOT)],
      ["GET", `${CHEMINS.coutsEquipes}?${TEAM_COSTS_MONTH_PARAM}=2026-09`],
      ["GET", constructionPath(CHEMINS.archivesEquipes, ROOT)],
      ["GET", CHEMINS.equipesConversations],
    ];
    for (const [methode, adresse] of adresses) {
      const entetes = methode === "GET" ? h.headers.authed : h.headers.mutating;
      const res = await h.call(methode, adresse, { headers: entetes });
      assert.equal(res.status, 404, `${methode} ${adresse} → ${res.status}`);
      assert.deepEqual(res.json(), { error: "not-found", message: "Route inconnue." }, `${methode} ${adresse} : capté par une route existante`);
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
    // Valeurs du plan §4.2, écrites ici en toutes lettres : depuis la bascule, comparer METHOD_LIMITS aux constantes importées
    // serait une tautologie. Ce sont les cinq valeurs décidées qui sont vérifiées, des deux côtés.
    assert.deepEqual(limites, { parAssistant: 2, parMessage: 2, parEtape: 2 });
    assert.deepEqual(
      [METHODS_PER_ASSISTANT, METHODS_PER_MESSAGE, METHODS_PER_STEP, METHOD_BLOCK_MAX_CHARS, METHOD_BLOCK_MAX_WORDS],
      [2, 2, 2, 900, 120],
    );
    assert.equal(METHOD_LIMITS.blocMaxCaracteres, METHOD_BLOCK_MAX_CHARS);
    assert.equal(METHOD_LIMITS.blocMaxMots, METHOD_BLOCK_MAX_WORDS);
    // Les valeurs ne sont plus recopiées : une seule source, celle de T5a.
    const source = fs.readFileSync(path.join(SERVER_DIR, "shared", "methods.ts"), "utf8");
    assert.ok(source.includes('from "./construction-constants.ts"'), "shared/methods.ts n'importe pas les limites");
    assert.equal(/^const METHODS_PER_/m.test(source), false, "une copie locale des limites est revenue dans shared/methods.ts");
  });

  it("ChronologieView du contrat est le type rendu par chronologie() : captures p1, p2, p6 et p7 relues sans exception", () => {
    let appelsVus = 0;
    for (const capture of CAPTURES) {
      const { state, now } = rejouer(capture);
      // Le type est celui de T5a, pas celui de L47a : la ligne ne compile que si les deux disent la même chose.
      const vue: ChronologieView = chronologie(state, [], now);
      assert.ok(Array.isArray(vue.rows) && Array.isArray(vue.groupes), capture);
      assert.equal(typeof vue.partiel, "boolean", capture);
      assert.ok(vue.rows.length > 0, `${capture} : aucune ligne`);
      for (const ligne of vue.rows) {
        assert.equal(typeof ligne.key, "string", capture);
        appelsVus += ligne.calls.length;
        for (const appel of ligne.calls) {
          // Honnêteté : sans ligne `usage`, les jetons et l'IA sont « non enregistrés », jamais 0 ni un nom inventé.
          assert.equal(appel.tokensIn, null, `${capture} / ${appel.messageId} : jetons d'entrée`);
          assert.equal(appel.tokensOut, null, `${capture} / ${appel.messageId} : jetons de sortie`);
          assert.equal(appel.model, null, `${capture} / ${appel.messageId} : IA`);
        }
      }
      // Bornes cohérentes quand elles existent (une conversation sans aucune ligne les laisse à null).
      if (vue.start !== null && vue.end !== null) assert.ok(vue.end >= vue.start, capture);
    }
    // Sans appel relu, les trois contrôles d'honnêteté ci-dessus ne prouveraient rien : le rejeu doit en produire.
    assert.ok(appelsVus >= 5, `captures relues sans appel d'IA (${appelsVus})`);
  });

  it("une ligne `usage` du registre remplit les jetons de son appel, et elle seule", () => {
    const { state, now } = rejouer("p1-delegation-parallele.jsonl");
    const sans = chronologie(state, [], now);
    const premier = sans.rows.flatMap((ligne) => ligne.calls.map((appel) => ({ appel, sessionId: ligne.sessionId })))[0];
    assert.ok(premier, "aucun appel dans p1");
    const ligneUsage: ChronologieUsageRow = {
      messageId: premier.appel.messageId,
      sessionId: premier.sessionId,
      agent: "orchestrateur",
      providerId: "github-copilot",
      modelId: "ia-de-croisement",
      variant: null,
      tokensInput: 100,
      tokensOutput: 10,
      tokensReasoning: 1,
      tokensCacheRead: 5,
      tokensCacheWrite: 2,
      cost: 0.5,
      createdAt: 1,
      completedAt: 2,
    };
    const avec = chronologie(state, [ligneUsage], now);
    const tous = avec.rows.flatMap((ligne) => ligne.calls);
    const rempli = tous.find((appel) => appel.messageId === premier.appel.messageId);
    assert.ok(rempli);
    // Entrée = input + cache lu + cache écrit ; sortie = output + réflexion (mêmes règles que ledger.summary).
    assert.equal(rempli.tokensIn, 107);
    assert.equal(rempli.tokensOut, 11);
    assert.equal(rempli.model, "ia-de-croisement");
    // Les autres appels restent « non enregistrés » : une ligne `usage` ne déborde jamais sur son voisin.
    for (const appel of tous.filter((a) => a.messageId !== premier.appel.messageId)) assert.equal(appel.tokensIn, null, appel.messageId);
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
