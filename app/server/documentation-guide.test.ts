// Garde de la documentation de l'utilisateur (refonte du README, 1.1.0) : les règles de gravité « erreur » de la grille de
// rédaction (grille.mjs de la refonte) qui se vérifient sans dépôt git, rejouées à chaque `npm test` sur README.md,
// docs/GUIDE.md et docs/DEVELOPPEMENT.md. Chaque règle a sa faute plantée (auto-test) : une règle qui ne voit plus sa faute
// fait échouer le test, pas seulement la documentation. Mots interdits : hors code et hors citation « … » ; une citation qui
// en porte un doit se trouver mot pour mot dans les textes du code (interface, textes partagés, scripts de l'hôte).
// Nom du fichier : jamais « croisements-c5… » (construction-balises.test.ts l'exigerait dans sa liste).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import * as docu from "./test-support/documentation.ts";

const README = "README.md";
const GUIDE = "docs/GUIDE.md";
const DEV = "docs/DEVELOPPEMENT.md";
const MAX_ETAPES = 7;
const MAX_LIGNES_README = 450;
/** Procédures irréversibles, dans l'ordre du guide : le titre porte « (irréversible » (comparaison sur le préfixe). */
const IRREVERSIBLES = ["P-17", "P-19", "P-37", "P-56"];
const MASQUE = String.fromCharCode(1);
const INSECABLES = [0xa0, 0x202f, 0x2007].map((c) => String.fromCharCode(c));

interface Faute {
  regle: string;
  doc: string;
  n: number;
  detail: string;
}

const masquer = (s: string, re: RegExp) => s.replace(re, (m) => MASQUE.repeat(m.length));
/** Prose d'une ligne : code en ligne, commentaires HTML, cibles de liens et adresses masqués (positions gardées). */
function prose(ligne: string): string {
  let p = masquer(ligne, /(`+)[^`]*?\1/g);
  p = masquer(p, /<!--.*?(?:-->|$)/g);
  p = p.replace(/\]\(([^)\s]*)\)/g, (_m, cible: string) => `](${MASQUE.repeat(cible.length)})`);
  p = masquer(p, /<https?:[^>\s]*>/g);
  return masquer(p, /https?:\/\/[^\s)>\]]+/g);
}
/** Citations « … » masquées, guillemets compris (imbrication tenue). */
function horsCitations(s: string): string {
  let sortie = "";
  let profondeur = 0;
  for (const c of s) {
    if (c === "«") profondeur += 1;
    sortie += profondeur > 0 ? MASQUE : c;
    if (c === "»" && profondeur > 0) profondeur -= 1;
  }
  return sortie;
}
/** Citation « … » qui contient la position `index` (guillemets exclus), ou null. */
function citationAutour(ligne: string, index: number): string | null {
  let debut = -1;
  let profondeur = 0;
  for (let i = 0; i < ligne.length; i += 1) {
    const c = ligne[i];
    if (c === "«") {
      if (profondeur === 0) debut = i + 1;
      profondeur += 1;
    } else if (c === "»" && profondeur > 0) {
      profondeur -= 1;
      if (profondeur === 0 && debut >= 0 && debut <= index && index < i) return ligne.slice(debut, i);
    }
  }
  return null;
}
const BLANCS = new RegExp(`[${INSECABLES.join("")}\\s]+`, "g");
const normaliser = (s: string) => s.replace(/`/g, "").replace(BLANCS, " ").trim();
/** Ancre d'un titre, comme croisements-it1-v5.test.ts. */
const slug = (titre: string) =>
  titre
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");

const BORD = (corps: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${corps}(?![\\p{L}\\p{N}_])`, "giu");
const MOTS_INTERDITS: Array<[string, RegExp]> = [
  ["simplement", BORD("simplement")],
  ["il suffit", BORD("il\\s+suffi(?:t|ra|rait)")],
  ["facile", BORD("facile(?:s|ment)?")],
  ["évident", BORD("(?:évident(?:e|es|s)?|évidemment)")],
  ["bien sûr", BORD("bien\\s+sûr")],
  ["basique", BORD("basiques?")],
  ["normalement", BORD("normalement")],
  ["n'oubliez pas", BORD("n['’]\\s*oubliez\\s+pas")],
  ["bravo", BORD("bravo")],
  ["pas de panique", BORD("pas\\s+de\\s+panique")],
  ["ci-dessus, ci-dessous…", BORD("ci[-‑](?:dessus|dessous|après|avant|contre)")],
  ["section suivante ou précédente", BORD("(?:section|partie|paragraphe|tableau|liste)\\s+(?:suivante?|précédente?)")],
];
const RE_ID = /(?<![\p{L}\p{N}_-])([PRXE]-\d{2})(?![\p{L}\p{N}_])/gu;
const RE_ETAPE = /^(\s*)[-*]\s+\[[ xX]\]\s+\*\*(\d+)\.\*\*\s*(.*)$/;

interface LigneLue {
  n: number;
  ligne: string;
  prose: string | null;
  titre: string | null;
}
/** Lignes annotées : hors bloc de code et hors commentaire HTML sur plusieurs lignes, la prose masquée et le titre. */
function analyser(texte: string): LigneLue[] {
  let bloc = false;
  let commentaire = false;
  return texte.split("\n").map((ligne, i) => {
    const lue: LigneLue = { n: i + 1, ligne, prose: null, titre: null };
    if (/^\s*(```|~~~)/.test(ligne)) bloc = !bloc;
    else if (bloc) return lue;
    else if (commentaire) {
      if (ligne.includes("-->")) commentaire = false;
    } else {
      if (ligne.replace(/<!--.*?-->/g, "").includes("<!--")) commentaire = true;
      lue.prose = prose(ligne);
      lue.titre = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(ligne)?.[1] ?? null;
    }
    return lue;
  });
}

/** Contrôle d'un jeu de documents (chemin → texte, fins de ligne LF). `citationConnue` : texte trouvé dans le code. */
function controler(docs: ReadonlyMap<string, string>, citationConnue: (morceau: string) => boolean): Faute[] {
  const fautes: Faute[] = [];
  const faute = (regle: string, doc: string, n: number, detail: string) => fautes.push({ regle, doc, n, detail });
  const definitions = new Map<string, { n: number; titre: string }>();
  for (const lue of analyser(docs.get(GUIDE) ?? "")) {
    const m = lue.titre && /^#{2,}\s/.test(lue.ligne) ? /^([PRXE]-\d{2})\s+\S/.exec(lue.titre) : null;
    if (!m?.[1] || !lue.titre) continue;
    if (definitions.has(m[1])) faute("identifiant-en-double", GUIDE, lue.n, m[1]);
    else definitions.set(m[1], { n: lue.n, titre: lue.titre });
  }
  const irreversibles = [...definitions].filter(([, d]) => d.titre.includes("(irréversible")).map(([id]) => id);
  if (docs.has(GUIDE) && irreversibles.join(",") !== IRREVERSIBLES.join(",")) faute("procedures-irreversibles", GUIDE, 0, irreversibles.join(","));

  for (const [doc, texte] of docs) {
    const lignes = analyser(texte);
    const total = texte.endsWith("\n") ? lignes.length - 1 : lignes.length;
    if (doc === README && total > MAX_LIGNES_README) faute("readme-longueur", doc, total, `${total} lignes`);
    // Étapes : chaque section qui en a, et chaque procédure P- du guide.
    let section: { titre: string; n: number; etapes: Array<{ n: number; numero: number; prose: string }> } | null = null;
    const finSection = () => {
      if (!section) return;
      const { titre, n, etapes } = section;
      if (doc === GUIDE && /^P-\d{2}\s/.test(titre) && etapes.length === 0) faute("procedure-sans-etapes", doc, n, titre);
      if (etapes.length > MAX_ETAPES) faute("etapes-trop-nombreuses", doc, n, `${titre} : ${etapes.length} étapes`);
      etapes.forEach((e, i) => {
        if (e.numero !== i + 1) faute("etape-numerotation", doc, e.n, `${titre} : ${e.numero} au lieu de ${i + 1}`);
        if (e.prose.trimStart().startsWith("→")) faute("etape-sans-action", doc, e.n, titre);
        else if (!e.prose.includes("→")) faute("etape-sans-resultat", doc, e.n, titre);
      });
    };
    let courante: { n: number; numero: number; prose: string; retrait: number } | null = null;
    for (const lue of lignes) {
      if (lue.prose === null) continue;
      if (lue.titre) {
        finSection();
        section = { titre: lue.titre, n: lue.n, etapes: [] };
        courante = null;
        if (INSECABLES.some((c) => lue.ligne.includes(c))) faute("insecable-titre", doc, lue.n, lue.titre);
      } else {
        const m = RE_ETAPE.exec(lue.ligne);
        if (m && section) {
          courante = { n: lue.n, numero: Number(m[2]), prose: lue.prose.slice(lue.ligne.length - (m[3] ?? "").length), retrait: (m[1] ?? "").length };
          section.etapes.push(courante);
        } else if (courante && lue.ligne.trim() !== "" && (/^\s*/.exec(lue.ligne)?.[0].length ?? 0) > courante.retrait) {
          courante.prose += ` ${lue.prose.trim()}`;
        } else if (lue.ligne.trim() === "" || !RE_ETAPE.test(lue.ligne)) courante = null;
      }
      // Mots interdits et renvois spatiaux : hors code et hors citation ; dans une citation, texte exact du code exigé.
      const dehors = horsCitations(lue.prose);
      for (const [nom, re] of MOTS_INTERDITS) {
        for (const m of lue.prose.matchAll(re)) {
          const index = m.index ?? 0;
          if (dehors.slice(index, index + m[0].length) === m[0]) {
            faute("mots-interdits", doc, lue.n, `« ${m[0]} » (${nom})`);
            continue;
          }
          const citation = citationAutour(lue.ligne, index);
          const morceau = citation === null ? "" : (citation.split("…").map(normaliser).find((x) => x.toLowerCase().includes(m[0].toLowerCase())) ?? "");
          if (!morceau || !citationConnue(morceau)) faute("mot-interdit-en-citation", doc, lue.n, `« ${m[0]} » dans une citation absente des textes du code`);
        }
      }
      // Renvois par identifiant : existants, et un lien [X-nn](…#ancre) vise le titre de X-nn.
      for (const m of lue.prose.matchAll(RE_ID)) {
        const id = m[1] ?? "";
        const titreDuGuide = doc === GUIDE && lue.titre !== null && (m.index ?? 0) === lue.ligne.indexOf(lue.titre);
        if (!titreDuGuide && !definitions.has(id)) faute("renvoi-inexistant", doc, lue.n, id);
      }
      for (const m of lue.ligne.matchAll(/\[([PRXE]-\d{2})\]\(([^)\s]*)\)/g)) {
        const cible = definitions.get(m[1] ?? "");
        const ancre = (m[2] ?? "").split("#")[1] ?? "";
        if (cible && ancre !== slug(cible.titre)) faute("renvoi-mauvaise-cible", doc, lue.n, `${m[1]} → #${ancre}`);
      }
    }
    finSection();
  }
  return fautes;
}

/** Textes du code où une citation doit se trouver : interface, textes partagés, scripts de l'hôte (tests exclus). */
function textesDuCode(): string {
  const fichiers: string[] = [];
  const parcourir = (dossier: string) => {
    for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
      const chemin = path.join(dossier, entree.name);
      if (entree.isDirectory()) {
        if (entree.name !== "node_modules" && entree.name !== "test-support") parcourir(chemin);
      } else if (/\.(ts|tsx)$/.test(entree.name) && !/\.test\.tsx?$/.test(entree.name)) fichiers.push(chemin);
    }
  };
  parcourir(path.join(docu.DEPOT, "app", "web"));
  parcourir(path.join(docu.DEPOT, "app", "server", "shared"));
  for (const script of ["install.ps1", "cockpit.ps1", "CockpitTls.ps1"]) fichiers.push(path.join(docu.DEPOT, script));
  return fichiers
    .map((f) => fs.readFileSync(f, "utf8"))
    .join("\n")
    .replace(/\{"\s*"\}/g, " ")
    .replace(/<\/?[A-Za-z][^<>]*>/g, " ")
    .replace(/\\u00a0|\\u202f/gi, " ")
    .replace(/\\n/g, " ")
    .replace(BLANCS, " ");
}

describe("documentation de l'utilisateur : grille de rédaction (refonte du README, 1.1.0)", () => {
  const code = textesDuCode();
  const connue = (morceau: string) => code.includes(morceau);

  it("auto-test : chaque règle voit sa faute plantée ; la même tournure en citation connue est acceptée", () => {
    const titreP = "P-01 Essai";
    const guide = [
      "# Guide",
      "",
      `### ${titreP}`,
      "",
      "- [ ] **1.** Ouvrir le cockpit. → Il s'ouvre.",
      "- [ ] **3.** Ouvrir **Diagnostic**. Il s'affiche.",
      "- [ ] **4.** → Rien à faire.",
      "",
      "### P-02 Sans étapes",
      "",
      "Texte seul, sans rien à cocher.",
      "",
      "### P-03 Trop d'étapes",
      "",
      ...Array.from({ length: 8 }, (_, i) => `- [ ] **${i + 1}.** Faire ${i + 1}. → Fait.`),
      "",
      "### P-01 Doublon",
      "",
      "- [ ] **1.** Faire. → Fait.",
      "",
      "### P-04 Tout effacer (irréversible)",
      "",
      "- [ ] **1.** Effacer. → Effacé.",
      "",
      `### R-01 Fiche${String.fromCharCode(0xa0)}insécable`,
      "",
      "Il suffit de lire la section suivante, ci-dessous. Voir [P-01](#p-02-sans-étapes) et X-99.",
      "« Le budget ci-dessous est suivi par le cockpit : il ne bloque rien côté GitHub. » « Simplement ceci ci-dessous, inventé. »",
      "`simplement` dans le code, et ```il suffit``` aussi.",
      "",
    ].join("\n");
    const fautes = controler(new Map([[GUIDE, guide], [README, "x\n".repeat(MAX_LIGNES_README + 1)]]), connue);
    const vues = new Set(fautes.map((f) => f.regle));
    for (const regle of [
      "identifiant-en-double",
      "procedures-irreversibles",
      "readme-longueur",
      "procedure-sans-etapes",
      "etapes-trop-nombreuses",
      "etape-numerotation",
      "etape-sans-action",
      "etape-sans-resultat",
      "insecable-titre",
      "mots-interdits",
      "mot-interdit-en-citation",
      "renvoi-inexistant",
      "renvoi-mauvaise-cible",
    ]) {
      assert.ok(vues.has(regle), `faute plantée non vue : ${regle}`);
    }
    // En prose : « Il suffit », « section suivante », « ci-dessous » ; la citation de BudgetTab.tsx passe, l'inventée non.
    const interdits = fautes.filter((f) => f.regle === "mots-interdits").map((f) => f.detail);
    assert.equal(interdits.length, 3, interdits.join(" | "));
    const enCitation = fautes.filter((f) => f.regle === "mot-interdit-en-citation");
    assert.equal(enCitation.length, 2, JSON.stringify(enCitation));
    assert.ok(connue("Le budget ci-dessous est suivi par le cockpit : il ne bloque rien côté GitHub."), "citation témoin introuvable dans le code");
  });

  it("README.md, docs/GUIDE.md et docs/DEVELOPPEMENT.md : aucune faute de gravité « erreur »", () => {
    const docs = new Map([README, GUIDE, DEV].map((doc) => [doc, fs.readFileSync(path.join(docu.DEPOT, ...doc.split("/")), "utf8").replace(/\r\n/g, "\n")] as const));
    const fautes = controler(docs, connue);
    assert.deepEqual(
      fautes.map((f) => `${f.doc}:${f.n} ${f.regle} ${f.detail}`),
      [],
    );
    // Le contrôle ne tourne pas à vide : identifiants et procédures du guide lus.
    const guide = docs.get(GUIDE) ?? "";
    assert.ok((guide.match(/^### P-\d{2} /gm) ?? []).length >= 50, "procédures du guide");
    assert.ok((guide.match(/^### [PRXE]-\d{2} /gm) ?? []).length >= 200, "identifiants du guide");
  });
});
