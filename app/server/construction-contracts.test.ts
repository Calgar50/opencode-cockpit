// Tests des contrats de la construction (itération 5, plan d'exécution it5 §4.5, T5a) : câblage propre, valeurs, textes.
// Sans buildCockpit11 : wiring-11.ts n'a pas encore les quatre lignes de la construction (posées par l'intégrateur du train de
// vague 0, D-5-04) ; le câblage dans la 1.1 est vérifié par le croisement du train (croisements-c5a-v0.test.ts).
// Les mots interdits et la structure de construction-texts.ts sont contrôlés par textes.test.ts, qui découvre le module par son
// nom, sans modification. Ce test ajoute ce que textes.test.ts ne couvre pas : les formulations du §1.3 du plan reprises à
// l'octet, « validez », « au moins » dans la Seconde lecture, la phrase de chaque code de refus et de chaque base d'estimation,
// et les deux variantes de l'annonce de mise à jour (D-5-24).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
  estimateSecondReading,
  getArchiveTeams,
  getChronologie,
  getMethods,
  getTeamConversations,
  getTeamCosts,
} from "../web/lib/api-construction.ts";
import type { Cockpit11, Registrar } from "./contracts-11.ts";
import type { ConstructionModuleName } from "./construction-contracts.ts";
import {
  ARCHIVE_EXCERPT_MAX,
  CHRONO_MAX_ROWS,
  CONSTRUCTION_ROUTE_PATHS,
  constructionPath,
  EQUIPIER_ROLE,
  METHOD_BLOCK_MAX_CHARS,
  METHOD_BLOCK_MAX_WORDS,
  METHODS_PER_ASSISTANT,
  METHODS_PER_MESSAGE,
  METHODS_PER_STEP,
  SECOND_READING_CATALOG_ID,
  SECOND_READING_TURN_KIND,
  TEAM_CONVERSATIONS_MAX,
  TEAM_COSTS_MONTH_PARAM,
  TEAM_COSTS_TOP,
} from "./shared/construction-constants.ts";
import { annonceMiseAJour, secondReadingPrefix, TEXTES } from "./shared/construction-texts.ts";
import type { ConstructionErrorCode } from "./shared/construction-types.ts";
import { STEP_ORDER } from "./wiring-11.ts";
import { CONSTRUCTION_HOOKS, CONSTRUCTION_MODULE_ORDER, CONSTRUCTION_MODULES, CONSTRUCTION_ROUTES } from "./wiring-construction.ts";

/**
 * Noms de ConstructionModuleName, écrits une fois pour le contrôle d'exécution : un nom ajouté au type sans l'être ici fait
 * échouer le typecheck, un nom ajouté ici sans l'être à CONSTRUCTION_MODULE_ORDER fait échouer ce test.
 */
const NOMS_DE_MODULE = {
  methods: true,
  secondReading: true,
  chronologie: true,
  teamCosts: true,
} satisfies Record<ConstructionModuleName, true>;

/** Mêmes noms pour les codes de refus : chaque code doit avoir sa phrase (§4.5). */
const CODES = {
  "methodes-trop": true,
  "methode-inconnue": true,
  "methode-non-attachable": true,
  "seconde-lecture-absente": true,
  "racine-inconnue": true,
} satisfies Record<ConstructionErrorCode, true>;

/** Registre d'essai : tout ce qu'un module inscrirait est tracé (un squelette n'inscrit rien). */
function registreTracant(trace: string[]): Registrar {
  return {
    hook: (step) => void trace.push(`hook/${step}`),
    derivation: (derivation) => void trace.push(`derivation/${derivation.name}`),
    hub: (type) => void trace.push(`hub/${type}`),
    startup: () => void trace.push("startup"),
    routes: (group) => void trace.push(`routes/${group}`),
  } as Registrar;
}

/** Toutes les feuilles d'un objet de textes, chemin compris. */
function feuilles(value: unknown, chemin = "", out: Array<{ chemin: string; texte: string }> = []): Array<{ chemin: string; texte: string }> {
  if (typeof value === "string") out.push({ chemin, texte: value });
  else if (value && typeof value === "object") {
    for (const [cle, item] of Object.entries(value)) feuilles(item, chemin ? `${chemin}.${cle}` : cle, out);
  }
  return out;
}

const textes = (value: unknown) => feuilles(value).map((f) => f.texte);

describe("construction : câblage propre", () => {
  it("CONSTRUCTION_MODULE_ORDER : les noms de ConstructionModuleName, sans doublon", () => {
    assert.deepEqual([...CONSTRUCTION_MODULE_ORDER], ["methods", "secondReading", "chronologie", "teamCosts"]);
    assert.deepEqual([...CONSTRUCTION_MODULE_ORDER].sort(), Object.keys(NOMS_DE_MODULE).sort());
    assert.equal(new Set(CONSTRUCTION_MODULE_ORDER).size, CONSTRUCTION_MODULE_ORDER.length);
  });

  // <c5:inscriptions-v1>
  // Train de V2 : les quatre modules de la construction sont livrés et inscrivent ce que leur fiche annonce. La table est
  // exhaustive et nommée module par module : un module qui perdrait une inscription ou en gagnerait une autre fait tomber ce
  // test. `chronologie` a reçu sa route au train de V2 (L47b) ; elle n'inscrit aucun crochet.
  const INSCRIPTIONS_ATTENDUES: Record<ConstructionModuleName, readonly string[]> = {
    methods: ["routes/construction"], // L44b, V1
    secondReading: ["hook/beforeBilledSend", "routes/construction"], // L44c, V1
    chronologie: ["routes/construction"], // L47b, V2
    teamCosts: ["routes/construction"], // L46a, V1
  };

  it("CONSTRUCTION_MODULES : un module par nom, à son rang, et n'inscrit que ce que sa fiche annonce", () => {
    assert.deepEqual(Object.keys(CONSTRUCTION_MODULES), [...CONSTRUCTION_MODULE_ORDER]);
    for (const name of CONSTRUCTION_MODULE_ORDER) {
      const module = CONSTRUCTION_MODULES[name];
      assert.equal(module.name, name);
      const trace: string[] = [];
      module.install(registreTracant(trace), {} as Cockpit11);
      assert.deepEqual(trace, [...INSCRIPTIONS_ATTENDUES[name]], name);
    }
  });
  // </c5:inscriptions-v1>

  it("CONSTRUCTION_HOOKS : le seul crochet est la Seconde lecture, sur une étape connue de STEP_ORDER", () => {
    assert.deepEqual(CONSTRUCTION_HOOKS, { beforeBilledSend: ["secondReading"] });
    for (const [etape, modules] of Object.entries(CONSTRUCTION_HOOKS)) {
      assert.ok(Object.keys(STEP_ORDER.hooks).includes(etape), etape);
      for (const module of modules) assert.ok(CONSTRUCTION_MODULE_ORDER.includes(module), module);
    }
  });

  it("CONSTRUCTION_ROUTES : un seul groupe, « construction », et seulement des modules de la construction", () => {
    assert.deepEqual(CONSTRUCTION_ROUTES.map(([, module]) => module).sort(), [...CONSTRUCTION_MODULE_ORDER].sort());
    for (const [groupe, module] of CONSTRUCTION_ROUTES) {
      assert.equal(groupe, "construction");
      assert.ok(CONSTRUCTION_MODULE_ORDER.includes(module), module);
    }
  });

  it("périmètre des animations : les dossiers de la construction sont ajoutés juste après SCOPES, et ils existent", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "web-animations.test.ts"), "utf8");
    const apresScopes = source.slice(source.indexOf("const SCOPES ="));
    // Train de V2 : les deux dossiers neufs de L44d et de L44e entrent dans le périmètre, comme le prévoit le §5.3.
    assert.ok(
      apresScopes.includes('SCOPES.push("pages/costs", "pages/archives", "pages/assistants/methods", "pages/chat/methods");'),
      "section du périmètre de la construction",
    );
    for (const dossier of ["pages/costs", "pages/archives", "pages/assistants/methods", "pages/chat/methods"]) {
      assert.ok(fs.statSync(path.join(import.meta.dirname, "..", "web", dossier)).isDirectory(), dossier);
    }
  });

  it("squelettes : « Propriétaire : Lxx » en première ligne", () => {
    const proprietaires: Record<string, string> = {
      "methods-service.ts": "L44b",
      "second-reading.ts": "L44c",
      "team-costs.ts": "L46a",
      "routes-chronologie.ts": "L47b",
    };
    for (const [fichier, proprietaire] of Object.entries(proprietaires)) {
      const premiere = fs.readFileSync(path.join(import.meta.dirname, fichier), "utf8").split("\n")[0] ?? "";
      assert.equal(premiere.replace(/\r$/, ""), `// Propriétaire : ${proprietaire}.`, fichier);
    }
  });
});

describe("construction : valeurs", () => {
  it("limites et bornes du plan §4.2", () => {
    assert.deepEqual([METHODS_PER_ASSISTANT, METHODS_PER_MESSAGE, METHODS_PER_STEP], [2, 2, 2]);
    assert.deepEqual([METHOD_BLOCK_MAX_CHARS, METHOD_BLOCK_MAX_WORDS], [900, 120]);
    assert.equal(SECOND_READING_TURN_KIND, "seconde-lecture");
    assert.equal(SECOND_READING_CATALOG_ID, "relecteur-critique");
    assert.equal(EQUIPIER_ROLE, "equipier");
    assert.deepEqual([CHRONO_MAX_ROWS, TEAM_COSTS_TOP, TEAM_CONVERSATIONS_MAX, ARCHIVE_EXCERPT_MAX], [2000, 10, 2000, 2000]);
  });
});

describe("construction : textes", () => {
  it("chaque code de refus a sa phrase, et aucune phrase n'est orpheline", () => {
    assert.deepEqual(Object.keys(TEXTES.partout.erreurs).sort(), Object.keys(CODES).sort());
    for (const [code, phrase] of Object.entries(TEXTES.partout.erreurs)) assert.ok(phrase.trim().length > 0, code);
  });

  it("chaque base d'estimation sauf « aucune » a sa phrase, sans « au moins » dans la Seconde lecture (D-5-22)", () => {
    assert.deepEqual(Object.keys(TEXTES.partout.secondeLecture.base).sort(), ["conversation", "observe", "profil"]);
    for (const [base, phrase] of Object.entries(TEXTES.partout.secondeLecture.base)) assert.ok(phrase.trim().length > 0, base);
    for (const texte of textes(TEXTES.partout.secondeLecture)) assert.equal(/au moins/i.test(texte), false, texte);
    assert.equal(TEXTES.partout.secondeLecture.bouton, "Seconde lecture (≈ {x} $)");
  });

  it("formulations du §1.3 reprises à l'octet", () => {
    assert.equal(TEXTES.partout.formes.aiguillage.phrase, "Un premier assistant propose le bon spécialiste dans une liste fixe ; vous confirmez son choix.");
    assert.equal(TEXTES.partout.methodes.creation.titre, "Méthodes (facultatif)");
    assert.equal(TEXTES.partout.execution.relecture.nonConclue, "Relecture non conclue après {n} tours : points restants ci-dessous.");
    assert.equal(TEXTES.partout.annonce.bientot, "Les équipes arrivent bientôt en mode Simple. En mode Avancé, vous pouvez déjà les essayer.");
  });

  it("mots écartés : « regard », « validez », « Réfléchit », « modèle » pour une IA ; « jeton » seulement en mode Avancé", () => {
    const interdits: ReadonlyArray<readonly [string, RegExp]> = [
      ["regard", /(?<![\p{L}-])regards?(?![\p{L}])/iu],
      ["validez", /(?<![\p{L}-])valid(?:ez|é|ée|és|ées|ation|ations)(?![\p{L}])/iu],
      ["Réfléchit", /r[ée]fl[ée]chi(?:t|ssent)(?![\p{L}])/iu],
      ["modèle", /(?<![\p{L}-])mod[èe]les?(?!\s+de\s+réflexion)(?![\p{L}])/iu],
    ];
    for (const { chemin, texte } of feuilles(TEXTES)) {
      for (const [mot, re] of interdits) assert.equal(re.test(texte), false, `${mot} : ${chemin} « ${texte} »`);
    }
    const jeton = /(?<![\p{L}-])jetons?(?![\p{L}])/iu;
    for (const { chemin, texte } of feuilles({ simple: TEXTES.simple, partout: TEXTES.partout })) {
      assert.equal(jeton.test(texte), false, `${chemin} « ${texte} »`);
    }
    assert.ok(textes(TEXTES.avance.chronologie).some((texte) => jeton.test(texte)), "la chronologie nomme les jetons en mode Avancé");
  });

  it("annonceMiseAJour : équipes ouvertes avec la phrase d'équipe, fermées sans elle et avec la phrase de l'itération 4 (D-5-24)", () => {
    const a = TEXTES.partout.annonce;
    const ouvertes = annonceMiseAJour({ equipesOuvertes: true });
    assert.equal(ouvertes.titre, "Nouveau : voir qui travaille, et faire travailler une équipe");
    assert.equal(ouvertes.texte, `${a.debut} ${a.equipe} ${a.fin}`);
    assert.ok(ouvertes.texte.includes(a.equipe));
    assert.equal(ouvertes.texte.includes(a.bientot), false);

    const fermees = annonceMiseAJour({ equipesOuvertes: false });
    assert.equal(fermees.titre, "Nouveau : voir qui travaille");
    assert.equal(fermees.texte, `${a.debut} ${a.fin} ${a.bientot}`);
    assert.equal(fermees.texte.includes(a.equipe), false);
    assert.ok(fermees.texte.endsWith(a.bientot));
  });

  it("secondReadingPrefix : début fixe du message, jusqu'au premier guillemet ouvrant", () => {
    assert.equal(secondReadingPrefix("reponse"), "Seconde lecture de la réponse précédente de ");
    assert.equal(secondReadingPrefix("equipe"), "Seconde lecture du résultat de l'équipe ");
    assert.ok(TEXTES.partout.secondeLecture.message.startsWith(secondReadingPrefix("reponse")));
    assert.ok(TEXTES.partout.secondeLecture.messageEquipe.startsWith(secondReadingPrefix("equipe")));
    for (const cible of ["reponse", "equipe"] as const) assert.equal(secondReadingPrefix(cible).includes("«"), false);
  });
});

interface Appel {
  method: string;
  url: string;
  csrf: string | undefined;
}

/** Remplace fetch : chaque appel est noté et reçoit 200 avec un corps vide (aucun réseau). */
function espionFetch(t: TestContext): Appel[] {
  const appels: Appel[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const entetes = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    appels.push({ method: init?.method ?? "GET", url: String(input), csrf: entetes["x-cockpit-csrf"] });
    return new Response(JSON.stringify({}), { status: 200 });
  });
  return appels;
}

describe("construction : client d'API", () => {
  it("adresses des six appels, identifiants encodés, en-tête anti-CSRF sur le seul POST", async (t) => {
    const appels = espionFetch(t);
    await getMethods();
    await estimateSecondReading({ directory: "/w/projet", sessionId: "ses_A1", cible: "reponse" });
    await getChronologie("ses_A1/b");
    await getTeamCosts("2026-09");
    await getTeamCosts();
    await getArchiveTeams("ses_A1");
    await getTeamConversations();
    assert.deepEqual(
      appels.map((a) => [a.method, a.url]),
      [
        ["GET", "/api/methods"],
        ["POST", "/api/chat/second-reading/estimate"],
        ["GET", "/api/conversations/ses_A1%2Fb/chronologie"],
        ["GET", "/api/usage/equipes?month=2026-09"],
        ["GET", "/api/usage/equipes"],
        ["GET", "/api/archives/ses_A1/equipes"],
        ["GET", "/api/equipes/conversations"],
      ],
    );
    assert.deepEqual(
      appels.map((a) => a.csrf),
      [undefined, "1", undefined, undefined, undefined, undefined, undefined],
    );
  });

  it("les six adresses sont celles des fiches du plan, et le client n'en écrit aucune lui-même", () => {
    // Valeurs des fiches : L44b (§6), L44c (l.752), L47b, L46a (l.785, l.791, l.794). Le paramètre de mois est `month`,
    // comme /api/usage/summary, parce que L46a le valide par MONTH_RE. Écrire ces adresses ici ET dans le client laissait les
    // deux s'écarter en silence ; elles ne vivent plus que dans construction-constants.ts, que les modules serveur liront aussi.
    assert.deepEqual({ ...CONSTRUCTION_ROUTE_PATHS }, {
      methodes: "/api/methods",
      secondeLectureEstimation: "/api/chat/second-reading/estimate",
      chronologie: "/api/conversations/:rootId/chronologie",
      coutsEquipes: "/api/usage/equipes",
      archivesEquipes: "/api/archives/:rootId/equipes",
      equipesConversations: "/api/equipes/conversations",
    });
    assert.equal(TEAM_COSTS_MONTH_PARAM, "month");
    // Aucune adresse en clair dans le client : une chaîne « /api/… » y serait une seconde source.
    const source = fs.readFileSync(path.join(import.meta.dirname, "..", "web", "lib", "api-construction.ts"), "utf8");
    assert.equal(/["'`]\/api\//.test(source), false, "api-construction.ts écrit une adresse au lieu de la lire dans les constantes");
    // `constructionPath` refuse un chemin sans paramètre : une erreur de branchement se voit, au lieu de partir vers /api/….
    assert.equal(constructionPath(CONSTRUCTION_ROUTE_PATHS.archivesEquipes, "a/b"), "/api/archives/a%2Fb/equipes");
    assert.throws(() => constructionPath(CONSTRUCTION_ROUTE_PATHS.methodes, "ses_A1"), /Chemin sans :rootId/);
  });
});
