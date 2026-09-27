// Balises « nav » des fichiers partagés (1.1, NAV-1 ; fiche NAV §1.2). Les ajouts de NAV dans un fichier qu'il ne possède pas
// sont encadrés pour que la grande fusion les retrouve, sous cinq formes :
//   TS/TSX            « // » puis la balise ouvrante, … « // » puis la balise fermante ;
//   expression JSX    la même balise dans « {/* … */} » ;
//   expression JS     la même balise dans « /* … */ » ;
//   YAML              « # » puis la balise ;
//   Markdown          commentaire HTML « nav:nom » … « /nav:nom ».
// La balise ouvrante s'écrit chevron, « nav », deux-points, nom, chevron ; la fermante, avec une barre après le premier chevron.
// L'élément JSX « nav » (sans deux-points) n'est pas une balise, pas plus que le commentaire de fin de ligne « // nav » (exception
// d'une seule ligne). Chaque balise ouverte est fermée, nommée, non imbriquée, un nom par section. Ce fichier n'écrit lui-même
// aucune balise : elles sont assemblées ci-dessous à partir de morceaux.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const NAV = "nav" + ":";
const DEPOT = path.join(import.meta.dirname, "..", "..");

/** Racines balayées, relatives au dépôt. */
const CIBLES: readonly string[] = ["app", "e2e", "docs", "README.md", "docker-compose.yml"];
/** Dossiers jamais parcourus (la copie de travail y met une jonction vers node_modules). */
const IGNORES: ReadonlySet<string> = new Set(["node_modules", "dist", ".git"]);
/** Fichiers texte lus. */
const EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".css", ".md", ".yml", ".yaml", ".sh", ".html", ".json", ".jsonc", ".ps1", ".cmd", ".txt"]);

const NOM = /^[\p{L}\p{N}_-]+$/u;

/** Les cinq formes (commentaires « // », « # », « /* … *\/ » avec ou sans accolades JSX, commentaire HTML). */
const FORMES: readonly RegExp[] = [
  new RegExp(`(?://|#)[ \\t]*<(/?)${NAV}([^>\\s]*)>`, "g"),
  new RegExp(`/\\*[ \\t]*<(/?)${NAV}([^>\\s]*)>[ \\t]*\\*/`, "g"),
  new RegExp(`<!--[ \\t]*(/?)${NAV}(\\S*?)[ \\t]*-->`, "g"),
];
/** Toute occurrence qui ressemble à une balise, bien formée ou non. */
const CANDIDAT = new RegExp(`</?${NAV}|<!--[ \\t]*/?${NAV}`, "g");

interface Balise {
  debut: number;
  fin: number;
  fermante: boolean;
  nom: string;
}

interface ProblemeBalise {
  ligne: number;
  probleme: "forme inconnue" | "sans nom" | "imbriquée" | "fermée sans ouverture" | "nom différent" | "non fermée";
}

const ligneDe = (texte: string, indice: number): number => texte.slice(0, indice).split("\n").length;

function balisesDe(texte: string): Balise[] {
  const trouvees: Balise[] = [];
  for (const forme of FORMES) {
    for (const m of texte.matchAll(forme)) {
      const debut = m.index ?? 0;
      trouvees.push({ debut, fin: debut + m[0].length, fermante: m[1] === "/", nom: m[2] ?? "" });
    }
  }
  return trouvees.sort((a, b) => a.debut - b.debut);
}

/** Problèmes des balises d'un texte, dans l'ordre des lignes. */
function analyserBalises(texte: string): ProblemeBalise[] {
  const balises = balisesDe(texte);
  const problemes: ProblemeBalise[] = [];
  for (const m of texte.matchAll(CANDIDAT)) {
    const at = m.index ?? 0;
    if (!balises.some((b) => b.debut <= at && at < b.fin)) problemes.push({ ligne: ligneDe(texte, at), probleme: "forme inconnue" });
  }
  const ouvertes: Balise[] = [];
  for (const balise of balises) {
    const ligne = ligneDe(texte, balise.debut);
    if (!NOM.test(balise.nom)) {
      problemes.push({ ligne, probleme: "sans nom" });
    } else if (!balise.fermante) {
      if (ouvertes.length > 0) problemes.push({ ligne, probleme: "imbriquée" });
      ouvertes.push(balise);
    } else {
      const ouverte = ouvertes.pop();
      if (ouverte === undefined) problemes.push({ ligne, probleme: "fermée sans ouverture" });
      else if (ouverte.nom !== balise.nom) problemes.push({ ligne, probleme: "nom différent" });
    }
  }
  for (const ouverte of ouvertes) problemes.push({ ligne: ligneDe(texte, ouverte.debut), probleme: "non fermée" });
  return problemes.sort((a, b) => a.ligne - b.ligne);
}

/** Fichiers balayés sous `racine`, chemins relatifs avec « / » ; ni lien, ni dossier ignoré, ni extension hors liste. */
function fichiersBalayes(racine: string): string[] {
  const trouves: string[] = [];
  const visiter = (relatif: string): void => {
    const absolu = path.join(racine, relatif);
    const infos = fs.lstatSync(absolu, { throwIfNoEntry: false });
    if (infos === undefined || infos.isSymbolicLink()) return;
    if (infos.isFile()) {
      if (EXTENSIONS.has(path.extname(relatif).toLowerCase())) trouves.push(relatif.replaceAll("\\", "/"));
      return;
    }
    if (!infos.isDirectory() || IGNORES.has(path.basename(relatif))) return;
    for (const entree of fs.readdirSync(absolu, { withFileTypes: true })) {
      if (entree.isSymbolicLink() || IGNORES.has(entree.name)) continue;
      visiter(path.join(relatif, entree.name));
    }
  };
  for (const cible of CIBLES) visiter(cible);
  return trouves.sort();
}

function problemesDuDepot(racine: string): Array<ProblemeBalise & { fichier: string }> {
  return fichiersBalayes(racine).flatMap((fichier) => analyserBalises(fs.readFileSync(path.join(racine, fichier), "utf8")).map((p) => ({ fichier, ...p })));
}

// Morceaux des sources fabriquées.
const ouvre = (nom: string) => `// <${NAV}${nom}>`;
const ferme = (nom: string) => `// </${NAV}${nom}>`;
const jsx = (nom: string, fin = false) => `{/* <${fin ? "/" : ""}${NAV}${nom}> */}`;
const js = (nom: string, fin = false) => `/* <${fin ? "/" : ""}${NAV}${nom}> */`;
const yaml = (nom: string, fin = false) => `# <${fin ? "/" : ""}${NAV}${nom}>`;
const md = (nom: string, fin = false) => `<!-- ${fin ? "/" : ""}${NAV}${nom} -->`;

describe("balises nav : contrôles discriminants sur des sources fabriquées", () => {
  it("les cinq formes bien écrites, l'élément JSX nav et le commentaire de fin de ligne ne donnent aucun problème", () => {
    const sources = [
      ["import a from './a.ts';", ouvre("env"), "const x = 1;", ferme("env")].join("\n"),
      ["<div>", `  ${jsx("section")}`, "  <FichiersPage />", `  ${jsx("section", true)}`, "</div>"].join("\n"),
      `const vue = ${js("section")} section === "fichiers" ? 1 : ${js("section", true)} 0;`,
      ["services:", "  cockpit:", `    ${yaml("montage")}`, "    - x:/y:ro", `    ${yaml("montage", true)}`].join("\n"),
      ["# Titre", md("fichiers"), "Texte.", md("fichiers", true)].join("\n"),
      ['<nav aria-label="Fichiers"><a href="#">x</a></nav>', '  | "fichiers" // nav', "const n = 1; // nav"].join("\n"),
      [ouvre("a"), ferme("a"), ouvre("a"), ferme("a"), ouvre("b"), ferme("b")].join("\n"),
    ];
    for (const source of sources) assert.deepEqual(analyserBalises(source), [], source);
  });

  it("balise non fermée, fermée sans ouverture, imbriquée, nom différent, sans nom, forme inconnue", () => {
    const cas: Array<[string, ProblemeBalise[]]> = [
      [[ouvre("env"), "x"].join("\n"), [{ ligne: 1, probleme: "non fermée" }]],
      [["x", ferme("env")].join("\n"), [{ ligne: 2, probleme: "fermée sans ouverture" }]],
      [[ouvre("a"), ouvre("b"), ferme("b"), ferme("a")].join("\n"), [{ ligne: 2, probleme: "imbriquée" }]],
      [[ouvre("a"), ferme("b")].join("\n"), [{ ligne: 2, probleme: "nom différent" }]],
      [[ouvre(""), ferme("")].join("\n"), [{ ligne: 1, probleme: "sans nom" }, { ligne: 2, probleme: "sans nom" }]],
      [`const s = "<${NAV}env>";`, [{ ligne: 1, probleme: "forme inconnue" }]],
      [`// <${NAV}env`, [{ ligne: 1, probleme: "forme inconnue" }]],
      [[md("doc"), "x"].join("\n"), [{ ligne: 1, probleme: "non fermée" }]],
      [[yaml("variables"), yaml("montage", true)].join("\n"), [{ ligne: 2, probleme: "nom différent" }]],
      [[jsx("ouvrir"), jsx("ouvrir"), jsx("ouvrir", true)].join("\n"), [{ ligne: 1, probleme: "non fermée" }, { ligne: 2, probleme: "imbriquée" }]],
    ];
    for (const [source, attendu] of cas) assert.deepEqual(analyserBalises(source), attendu, source);
  });

  it("balayage : app, e2e, docs, README.md et docker-compose.yml seulement, sans node_modules, dist ni .git", () => {
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-nav1-balises-"));
    try {
      const ecrire = (relatif: string, texte: string) => {
        fs.mkdirSync(path.dirname(path.join(dossier, relatif)), { recursive: true });
        fs.writeFileSync(path.join(dossier, relatif), texte);
      };
      ecrire("app/server/a.ts", ouvre("orpheline"));
      ecrire("app/node_modules/b/index.ts", ouvre("x"));
      ecrire("app/dist/c.js", ouvre("x"));
      ecrire(".git/d.md", md("x"));
      ecrire("app/.git/d.md", md("x"));
      ecrire("docs/dist/h.md", md("x"));
      ecrire("docs/e.md", [md("doc"), md("doc", true)].join("\n"));
      ecrire("e2e/f.mjs", "export {};");
      ecrire("e2e/image.png", ouvre("x"));
      ecrire("README.md", "# Lisez-moi");
      ecrire("docker-compose.yml", yaml("x"));
      ecrire("autre/g.ts", ouvre("x"));
      assert.deepEqual(fichiersBalayes(dossier), ["README.md", "app/server/a.ts", "docker-compose.yml", "docs/e.md", "e2e/f.mjs"]);
      assert.deepEqual(problemesDuDepot(dossier), [
        { fichier: "app/server/a.ts", ligne: 1, probleme: "non fermée" },
        { fichier: "docker-compose.yml", ligne: 1, probleme: "non fermée" },
      ]);
    } finally {
      fs.rmSync(dossier, { recursive: true, force: true });
    }
  });
});

describe("balises nav : dépôt", () => {
  it("chaque balise nav du dépôt est bien formée, fermée, nommée, non imbriquée (vrai aussi à vide)", () => {
    const fichiers = fichiersBalayes(DEPOT);
    assert.ok(fichiers.length > 200, `${fichiers.length} fichiers balayés`);
    for (const attendu of ["README.md", "docker-compose.yml", "app/server/fichiers-balises.test.ts", "app/web/app/App.tsx"]) assert.ok(fichiers.includes(attendu), attendu);
    assert.equal(fichiers.some((f) => f.split("/").some((segment) => IGNORES.has(segment))), false);
    assert.deepEqual(problemesDuDepot(DEPOT), []);
  });
});
