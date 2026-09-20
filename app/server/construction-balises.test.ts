// Test des balises de la construction (itération 5, plan d'exécution it5 §2.6, §2.7, §4.5, T5a, D-5-05, D-5-26).
// Dans un fichier partagé de CLASSE A (fichiers que d'autres branches écrivent aussi), tout ajout de la construction est entre
// balises, sauf les exceptions d'une seule ligne du §2.6 (commentaire « // c5 » en fin de ligne), qui ne sont pas des balises.
// Syntaxes : « // <NOM> … // </NOM> » (TS, TSX), « {/* <NOM> */} … {/* </NOM> */} » (JSX), « /* <NOM> */ … » (CSS),
// « <!-- NOM --> … <!-- /NOM --> » (Markdown), NOM étant le préfixe de la construction suivi du nom de la section.
// Contrôles : chaque fichier de FICHIERS_PARTAGES_C5 existe (un fichier listé absent fait échouer) ; dans ce fichier et dans tout
// fichier d'app/, e2e/, docs/ et README.md où une balise est trouvée, chaque balise ouverte est fermée, nommée et non imbriquée.
// Ce test s'exclut lui-même : il cite les balises pour les reconnaître, sans en ouvrir aucune.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/** Racine du dépôt (app/server → app → dépôt). */
const ROOT = path.join(import.meta.dirname, "..", "..");

/**
 * Fichiers partagés de classe A du §2.7 qui existent aujourd'hui. Un paquet qui ajoute un fichier partagé l'ajoute à cette liste :
 * `shared/methods.ts` et `methods-catalogue.ts` par L44a, `shared/chronologie.ts` par L47a, `croisements-c5*.test.ts` par
 * l'intégrateur. Les fichiers de classe B (fichiers neufs de l'itération 4, réunis par FE4) ne sont pas listés : leurs balises
 * sont recommandées, jamais exigées, et ce test les contrôle quand il en trouve.
 */
const FICHIERS_PARTAGES_C5: readonly string[] = [
  // Fichiers propres à la construction (T5a).
  "app/server/shared/construction-types.ts",
  "app/server/shared/construction-constants.ts",
  "app/server/shared/construction-texts.ts",
  "app/server/construction-contracts.ts",
  "app/server/wiring-construction.ts",
  "app/web/lib/api-construction.ts",
  "app/server/methods-service.ts",
  "app/server/second-reading.ts",
  "app/server/team-costs.ts",
  "app/server/routes-chronologie.ts",
  // Contrats et câblage 1.1 : l'intégrateur seul les écrit (D-5-04).
  "app/server/contracts-11.ts",
  "app/server/wiring-11.ts",
  "app/server/wiring-11.test.ts",
  // Fichiers partagés modifiés par la construction.
  "app/web/lib/types.ts",
  "app/server/web-animations.test.ts",
  "app/server/assistants-catalogue.ts",
  "app/server/assistants.test.ts",
  "app/server/assistants.ts",
  "app/server/shared/assistant-rules.ts",
  "app/server/shared/api-types.ts",
  "app/server/db.ts",
  "app/server/ledger.ts",
  "app/server/archive.ts",
  "app/web/pages/assistants/AssistantWizard.tsx",
  "app/web/pages/assistants/IdentityCard.tsx",
  "app/web/pages/assistants/CatalogueGrid.tsx",
  "app/web/pages/AssistantsPage.tsx",
  "app/web/lib/router.ts",
  "app/web/pages/chat/Composer.tsx",
  "app/web/pages/chat/MessageView.tsx",
  "app/web/pages/chat/activity/Deroule.tsx",
  "app/web/pages/CostsPage.tsx",
  "app/web/pages/archives/ArchiveDetail.tsx",
  "app/web/pages/archives/ArchiveList.tsx",
  "app/web/pages/chat/activity/DemoPlayer.tsx",
  "e2e/fake-opencode-server.ts",
  "e2e/README.md",
  "README.md",
  "docs/RECAPITULATIF.md",
];

/** Ce test, exclu de la recherche : il cite les balises sans en ouvrir. */
const CE_TEST = "app/server/construction-balises.test.ts";

const RACINES: readonly string[] = ["app", "e2e", "docs", "README.md"];
const DOSSIERS_IGNORES = new Set(["node_modules", "dist", ".git", ".vite", "coverage", "data", "workspace", "archives"]);
const EXTENSIONS = /\.(?:tsx?|jsx?|mjs|cjs|css|md|html|ya?ml)$/i;

/** Toute forme qui ressemble à une balise de la construction, bien formée ou non (parcours, puis simple présence). */
const CANDIDATE = /<!--\s*\/?\s*c5:[^>]*-->|<\/?c5:[^>]*>/g;
const CANDIDATE_UNE = /<!--\s*\/?\s*c5:[^>]*-->|<\/?c5:[^>]*>/;

/** Balise bien formée : Markdown « <!-- c5:nom --> » et « <!-- /c5:nom --> », ou « <c5:nom> » et « </c5:nom> ». */
const BALISE = /^(?:<!--\s*(\/?)c5:([A-Za-z][\w-]*)\s*-->|<(\/?)c5:([A-Za-z][\w-]*)>)$/;

interface Violation {
  fichier: string;
  ligne: number;
  regle: string;
}

/** Balises d'un source : chacune fermée, nommée, non imbriquée. */
function verifierBalises(fichier: string, source: string): Violation[] {
  const problemes: Violation[] = [];
  const ligneDe = (at: number) => source.slice(0, at).split("\n").length;
  let ouverte: { nom: string; at: number } | null = null;
  for (const candidate of source.matchAll(CANDIDATE)) {
    const brut = candidate[0];
    const at = candidate.index ?? 0;
    const forme = BALISE.exec(brut);
    if (!forme) {
      problemes.push({ fichier, ligne: ligneDe(at), regle: `balise mal formée ou sans nom : ${brut}` });
      continue;
    }
    const fermante = (forme[1] ?? forme[3]) === "/";
    const nom = forme[2] ?? forme[4] ?? "";
    if (!fermante) {
      if (ouverte) problemes.push({ fichier, ligne: ligneDe(at), regle: `balise imbriquée : ${nom} dans ${ouverte.nom}` });
      else ouverte = { nom, at };
    } else if (!ouverte) {
      problemes.push({ fichier, ligne: ligneDe(at), regle: `balise fermée sans ouverture : ${nom}` });
    } else if (ouverte.nom !== nom) {
      problemes.push({ fichier, ligne: ligneDe(at), regle: `balise fermée par un autre nom : ${ouverte.nom} puis ${nom}` });
      ouverte = null;
    } else {
      ouverte = null;
    }
  }
  if (ouverte) problemes.push({ fichier, ligne: ligneDe(ouverte.at), regle: `balise non fermée : ${ouverte.nom}` });
  return problemes;
}

/** Fichiers d'une liste qui ne sont pas dans le dépôt : un fichier listé absent fait échouer le test (§4.5). */
const absents = (liste: readonly string[]) => liste.filter((fichier) => !fs.existsSync(path.join(ROOT, fichier)));

/** Fichiers texte des racines de la recherche, chemins relatifs au dépôt, séparateur « / ». */
function fichiersScannes(): string[] {
  const out: string[] = [];
  const marcher = (relatif: string) => {
    const absolu = path.join(ROOT, relatif);
    const stat = fs.statSync(absolu);
    if (stat.isFile()) {
      if (EXTENSIONS.test(relatif)) out.push(relatif);
      return;
    }
    for (const entree of fs.readdirSync(absolu, { withFileTypes: true })) {
      if (entree.isDirectory()) {
        if (!DOSSIERS_IGNORES.has(entree.name)) marcher(`${relatif}/${entree.name}`);
      } else if (entree.isFile() || entree.isSymbolicLink()) {
        if (EXTENSIONS.test(entree.name)) out.push(`${relatif}/${entree.name}`);
      }
    }
  };
  for (const racine of RACINES) marcher(racine);
  return out.filter((fichier) => fichier !== CE_TEST).sort();
}

describe("balises c5 : contrôles discriminants", () => {
  const cas: ReadonlyArray<readonly [string, string, string]> = [
    ["non fermée", "// <" + "c5:types>\nexport const x = 1;\n", "balise non fermée"],
    ["fermée sans ouverture", "export const x = 1;\n// </" + "c5:types>\n", "balise fermée sans ouverture"],
    ["imbriquée", "// <" + "c5:a>\n// <" + "c5:b>\n// </" + "c5:b>\n// </" + "c5:a>\n", "balise imbriquée"],
    ["nom différent", "// <" + "c5:a>\n// </" + "c5:b>\n", "balise fermée par un autre nom"],
    ["sans nom", "// <" + "c5:>\n", "balise mal formée ou sans nom"],
    ["Markdown non fermée", "<!-- " + "c5:section -->\ntexte\n", "balise non fermée"],
  ];

  for (const [nom, source, attendu] of cas) {
    it(`échoue : ${nom}`, () => {
      const problemes = verifierBalises("essai.ts", source);
      assert.ok(problemes.some((p) => p.regle.startsWith(attendu)), `${nom} → ${JSON.stringify(problemes)}`);
    });
  }

  it("réussit : sections successives, JSX, CSS et Markdown équilibrés", () => {
    const source = [
      "// <" + "c5:types>",
      "export const a = 1;",
      "// </" + "c5:types>",
      "{/* <" + "c5:puce> */}",
      "<Puce />",
      "{/* </" + "c5:puce> */}",
      "/* <" + "c5:styles> */",
      ".x { color: red }",
      "/* </" + "c5:styles> */",
      "<!-- " + "c5:section -->",
      "texte",
      "<!-- /" + "c5:section -->",
      "const exception = 1; // c5",
      "balises " + "c5: citées en prose, sans chevrons",
    ].join("\n");
    assert.deepEqual(verifierBalises("essai.tsx", source), []);
  });

  it("échoue : fichier listé absent du dépôt", () => {
    assert.deepEqual(absents(["app/server/db.ts", "app/server/jamais-livre-c5.ts"]), ["app/server/jamais-livre-c5.ts"]);
  });
});

describe("balises c5 : dépôt", () => {
  it("chaque fichier partagé de classe A du §2.7 existe", () => {
    assert.deepEqual(absents(FICHIERS_PARTAGES_C5), []);
    assert.equal(new Set(FICHIERS_PARTAGES_C5).size, FICHIERS_PARTAGES_C5.length, "aucun doublon dans la liste");
  });

  it("balises équilibrées, nommées et non imbriquées dans les fichiers partagés et partout où il en existe", () => {
    const scannes = fichiersScannes();
    const avecBalise = scannes.filter((fichier) => CANDIDATE_UNE.test(fs.readFileSync(path.join(ROOT, fichier), "utf8")));
    const controles = [...new Set([...FICHIERS_PARTAGES_C5.filter((f) => f !== CE_TEST), ...avecBalise])].sort();
    const problemes = controles.flatMap((fichier) => verifierBalises(fichier, fs.readFileSync(path.join(ROOT, fichier), "utf8")));
    assert.deepEqual(problemes, []);
    // T5a pose deux sections ; les paquets suivants en ajoutent d'autres, toutes contrôlées par la recherche ci-dessus.
    for (const fichier of ["app/server/web-animations.test.ts", "app/web/lib/types.ts"]) assert.ok(avecBalise.includes(fichier), fichier);
  });
});
