// Entrées de « Revoir » dans l'interface (itération 3, L28b ; spécification §5.7.4 l.985, §5.9 l.1018-1024 ; plan d'exécution it3
// §6 « L28b », D-3d-12, D-3d-24). Contrôles STATIQUES, commentaires ignorés pour tout ce qui parle d'imports et d'API :
// - `NeonBand.tsx` porte EXACTEMENT UNE section balisée [3d], qui ne contient que l'élément <BandCommands3d/> ; la seule autre
//   ligne qui cite le composant est son import, sur une ligne unique balisée « // [3d] ». « Revoir » ne monte jamais la bande
//   (D-3d-12) : aucun autre ajout n'y est permis ;
// - même règle pour `ArchiveDetail.tsx` et <RevoirEntree/>, placé juste avant <Deroule … placement="archives" …/> ;
// - `BandCommands3d.tsx` et `RevoirEntree.tsx` n'ont d'autre module d'API que `web/lib/api-salle3d.ts` (lecture seule) : ni
//   `api.ts`, ni `api-activity.ts`, ni `fetch`, ni `oc.`, ni `NeonBand.tsx` ;
// - gardes des deux composants : aucun bouton pour une racine de la Salle OMO en mode Simple, [Ouvrir la salle de contrôle]
//   derrière `verdictCapacites` (sans sonde) et la préférence du poste, [Revoir cette demande] des Archives derrière `revoirEtat`,
//   rien pour « salle-demande-en-cours », la phrase du refus pour « salle-fin-inconnue » ;
// - aucun texte affichable écrit dans les composants : tout vient des modules de textes (T3d-b).
// Chaque règle échoue sur un source fabriqué (contrôles discriminants).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { TEXTES as TEXTES_REVOIR } from "./shared/revoir-texts.ts";
import { TEXTES as TEXTES_SALLE } from "./shared/salle3d-texts.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const lire = (relatif: string) => fs.readFileSync(path.join(APP_DIR, relatif), "utf8");

const NEON_BAND = "web/pages/chat/activity/NeonBand.tsx";
const ARCHIVE_DETAIL = "web/pages/archives/ArchiveDetail.tsx";
const BAND_COMMANDS = "web/pages/salle-controle/revoir/BandCommands3d.tsx";
const REVOIR_ENTREE = "web/pages/salle-controle/revoir/RevoirEntree.tsx";

// --- Outillage statique (recopié de salle3d-contrats.test.ts) -----------------------------------------------------------------

/** Texte sans commentaires, lu de gauche à droite. */
function sansCommentaires(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

/** Modules importés : déclarations en début de ligne (sur plusieurs lignes comprises) et import() dynamiques. */
function importsOf(source: string): string[] {
  const code = sansCommentaires(source);
  return [
    ...[...code.matchAll(/^[ \t]*(?:import|export)\b[^;]*?\bfrom[ \t]*["']([^"']+)["']/gm)].map((m) => m[1] ?? ""),
    ...[...code.matchAll(/^[ \t]*import[ \t]*["']([^"']+)["']/gm)].map((m) => m[1] ?? ""),
    ...[...code.matchAll(/\bimport[ \t]*\([ \t]*["']([^"']+)["'][ \t]*\)/g)].map((m) => m[1] ?? ""),
  ];
}

// --- Sections balisées [3d] (D-3d-24) ------------------------------------------------------------------------------------------

interface Balisage {
  /** Lignes de chaque section [3d], sans les lignes de balise. */
  sections: string[][];
  /** Lignes hors de toute section, avec leur numéro (1 en tête de fichier). */
  dehors: Array<{ n: number; texte: string }>;
  /** Chaque « début » est fermé par un « fin » avant le suivant. */
  equilibre: boolean;
}

function baliser(source: string): Balisage {
  const sections: string[][] = [];
  const dehors: Array<{ n: number; texte: string }> = [];
  let courante: string[] | null = null;
  let equilibre = true;
  const lignes = source.split("\n");
  for (const [index, texte] of lignes.entries()) {
    const marque = /\[3d\] (début|fin)\b/.exec(texte);
    if (marque === null) {
      if (courante === null) dehors.push({ n: index + 1, texte });
      else courante.push(texte);
      continue;
    }
    if (marque[1] === "début") {
      if (courante !== null) equilibre = false;
      courante = [];
    } else {
      if (courante === null) equilibre = false;
      else sections.push(courante);
      courante = null;
    }
  }
  if (courante !== null) equilibre = false;
  return { sections, dehors, equilibre };
}

/**
 * Règle d'une entrée 3d posée dans un fichier partagé (D-3d-24) : une seule section [3d], qui ne contient que l'élément du
 * composant, et une seule ligne hors section qui le cite — son import, balisé « // [3d] ». Rend la liste des manquements.
 */
function regleEntree(source: string, composant: string, element: RegExp): string[] {
  const manquements: string[] = [];
  const { sections, dehors, equilibre } = baliser(source);
  if (!equilibre) manquements.push("sections [3d] déséquilibrées");
  if (sections.length !== 1) manquements.push(`${sections.length} section(s) [3d] au lieu d'une`);
  for (const section of sections) {
    const utiles = section.filter((ligne) => ligne.trim() !== "");
    if (utiles.length !== 1) manquements.push(`section de ${utiles.length} ligne(s) utiles au lieu d'une`);
    else if (!element.test(utiles[0] ?? "")) manquements.push(`élément inattendu dans la section : ${utiles[0]?.trim() ?? ""}`);
  }
  const citations = dehors.filter((ligne) => new RegExp(`\\b${composant}\\b`).test(ligne.texte));
  if (citations.length !== 1) manquements.push(`${citations.length} ligne(s) hors section citent ${composant}`);
  for (const ligne of citations) {
    if (!/^import \{[^}]*\} from "[^"]+"; \/\/ \[3d\]$/.test(ligne.texte.trim())) manquements.push(`ligne ${ligne.n} non balisée : ${ligne.texte.trim()}`);
  }
  return manquements;
}

/** Ligne utile qui suit la section [3d] (lignes vides passées) : l'ancre devant laquelle l'entrée est posée. */
function ligneApresSection(source: string): string {
  const lignes = source.split("\n");
  const fin = lignes.findIndex((ligne) => /\[3d\] fin\b/.test(ligne));
  if (fin === -1) return "";
  for (const ligne of lignes.slice(fin + 1)) if (ligne.trim() !== "") return ligne.trim();
  return "";
}

// --- Modules d'API et lecture seule --------------------------------------------------------------------------------------------

/** Basename des modules d'API (`web/lib/api*.ts`) importés par ce fichier. */
function modulesApi(source: string): string[] {
  return importsOf(source)
    .map((spec) => spec.split("/").at(-1) ?? "")
    .filter((base) => /^api(?:-[a-z0-9-]+)?\.ts$/.test(base));
}

/** Manquements à la lecture seule d'un composant de « Revoir » : autre module d'API, fetch, oc., NeonBand monté. */
function regleLectureSeule(source: string): string[] {
  const code = sansCommentaires(source);
  const manquements: string[] = [];
  for (const base of modulesApi(source)) if (base !== "api-salle3d.ts") manquements.push(`module d'API interdit : ${base}`);
  if (/\bfetch\s*\(/.test(code)) manquements.push("appel direct à fetch");
  if (/\boc\./.test(code)) manquements.push("appel à oc.");
  if (importsOf(source).some((spec) => spec.endsWith("NeonBand.tsx"))) manquements.push("NeonBand importé (D-3d-12)");
  return manquements;
}

// --- Sources fabriqués (contrôles discriminants) ---------------------------------------------------------------------------------

const BANDE_BONNE = [
  'import { BandCommands3d } from "../../salle-controle/revoir/BandCommands3d.tsx"; // [3d]',
  "  <div>",
  "    {/* [3d] début : commandes (L28b) */}",
  "    <BandCommands3d rootId={rootId} facts={facts} advanced={advanced} />",
  "    {/* [3d] fin */}",
  "  </div>",
].join("\n");

describe("entrées de « Revoir » (L28b) : les règles échouent sur un source fabriqué", () => {
  const element = /<BandCommands3d\b/;

  it("source conforme : aucun manquement", () => {
    assert.deepEqual(regleEntree(BANDE_BONNE, "BandCommands3d", element), []);
  });

  it("import non balisé, deux sections, section chargée, élément absent, balises déséquilibrées", () => {
    const sansBalise = BANDE_BONNE.replace('.tsx"; // [3d]', '.tsx";');
    assert.deepEqual(regleEntree(sansBalise, "BandCommands3d", element), ['ligne 1 non balisée : import { BandCommands3d } from "../../salle-controle/revoir/BandCommands3d.tsx";']);

    const deuxSections = `${BANDE_BONNE}\n{/* [3d] début : autre */}\n<BandCommands3d rootId={rootId} facts={facts} advanced={advanced} />\n{/* [3d] fin */}`;
    assert.deepEqual(regleEntree(deuxSections, "BandCommands3d", element), ["2 section(s) [3d] au lieu d'une"]);

    const horsSection = `${BANDE_BONNE}\n  const aussi = <BandCommands3d rootId={rootId} facts={facts} advanced={advanced} />;`;
    assert.deepEqual(regleEntree(horsSection, "BandCommands3d", element), [
      "2 ligne(s) hors section citent BandCommands3d",
      "ligne 7 non balisée : const aussi = <BandCommands3d rootId={rootId} facts={facts} advanced={advanced} />;",
    ]);

    const chargee = BANDE_BONNE.replace("    {/* [3d] fin */}", "    <p>ajout</p>\n    {/* [3d] fin */}");
    assert.deepEqual(regleEntree(chargee, "BandCommands3d", element), ["section de 2 ligne(s) utiles au lieu d'une"]);

    const autreElement = BANDE_BONNE.replace("<BandCommands3d rootId={rootId} facts={facts} advanced={advanced} />", "<NeonBand rootId={rootId} />");
    assert.ok(regleEntree(autreElement, "BandCommands3d", element).some((m) => m.startsWith("élément inattendu")));

    const ouverte = BANDE_BONNE.replace("    {/* [3d] fin */}", "");
    assert.ok(regleEntree(ouverte, "BandCommands3d", element).includes("sections [3d] déséquilibrées"));
  });

  it("lecture seule : un autre module d'API, fetch, oc. ou NeonBand sont vus ; un commentaire ne compte pas", () => {
    assert.deepEqual(regleLectureSeule('import { salle3dApi } from "../../../lib/api-salle3d.ts";\nsalle3dApi.revoir(rootId);\n'), []);
    assert.deepEqual(regleLectureSeule('import { api } from "../../../lib/api.ts";\n'), ["module d'API interdit : api.ts"]);
    assert.deepEqual(regleLectureSeule('import { activityApi } from "../../../lib/api-activity.ts";\n'), ["module d'API interdit : api-activity.ts"]);
    assert.deepEqual(regleLectureSeule("const r = await fetch(url);\n"), ["appel direct à fetch"]);
    assert.deepEqual(regleLectureSeule("const m = await oc.messages(id);\n"), ["appel à oc."]);
    assert.deepEqual(regleLectureSeule('import { NeonBand } from "../../chat/activity/NeonBand.tsx";\n'), ["NeonBand importé (D-3d-12)"]);
    assert.deepEqual(regleLectureSeule('// import { api } from "../../../lib/api.ts";\n// await fetch(url);\n'), []);
  });

  it("ancre : la ligne utile qui suit la section est lue, lignes vides passées", () => {
    assert.equal(ligneApresSection("{/* [3d] début : a */}\n<X />\n{/* [3d] fin */}\n\n  <Deroule rootId={id} />\n"), "<Deroule rootId={id} />");
    assert.equal(ligneApresSection("<X />\n"), "");
  });
});

// --- Fichiers partagés ------------------------------------------------------------------------------------------------------------

describe("entrées de « Revoir » (L28b) : sections balisées des fichiers partagés (D-3d-24)", () => {
  it("NeonBand.tsx : une seule section [3d], le seul élément <BandCommands3d/>, import balisé sur une ligne", () => {
    const source = lire(NEON_BAND);
    assert.deepEqual(regleEntree(source, "BandCommands3d", /<BandCommands3d\b/), []);
    const section = baliser(source).sections[0]?.find((ligne) => ligne.trim() !== "") ?? "";
    assert.equal(section.trim(), "<BandCommands3d rootId={rootId} facts={facts} advanced={advanced} />");
  });

  it("ArchiveDetail.tsx : une seule section [3d], le seul élément <RevoirEntree/>, juste avant le Déroulé des Archives", () => {
    const source = lire(ARCHIVE_DETAIL);
    assert.deepEqual(regleEntree(source, "RevoirEntree", /<RevoirEntree\b/), []);
    const section = baliser(source).sections[0]?.find((ligne) => ligne.trim() !== "") ?? "";
    assert.equal(section.trim(), '<RevoirEntree rootId={sessionId} placement="archives" />');
    const apres = ligneApresSection(source);
    assert.match(apres, /^<Deroule\b/);
    assert.match(apres, /placement="archives"/);
  });
});

// --- Composants de L28b -------------------------------------------------------------------------------------------------------------

describe("entrées de « Revoir » (L28b) : lecture seule et gardes des composants", () => {
  it("BandCommands3d.tsx et RevoirEntree.tsx : api-salle3d.ts est leur seul module d'API, sans fetch ni oc.", () => {
    for (const fichier of [BAND_COMMANDS, REVOIR_ENTREE]) assert.deepEqual(regleLectureSeule(lire(fichier)), [], fichier);
    // RevoirEntree lit bien l'accès par ce module ; BandCommands3d ne demande rien (la boîte de dialogue lit elle-même).
    assert.deepEqual(modulesApi(lire(REVOIR_ENTREE)), ["api-salle3d.ts"]);
    assert.deepEqual(modulesApi(lire(BAND_COMMANDS)), []);
  });

  it("BandCommands3d : aucun bouton pour une racine de la Salle OMO en mode Simple", () => {
    const code = sansCommentaires(lire(BAND_COMMANDS));
    assert.match(code, /const salleEnSimple = !advanced && racineDeLaSalle\(facts, rootId\);/);
    assert.match(code, /if \(salleEnSimple\) return null;/);
    assert.match(code, /fait\.data\.instance === "omo"/);
  });

  it("BandCommands3d : [Ouvrir la salle de contrôle] derrière verdictCapacites (sans sonde) et la préférence du poste", () => {
    const code = sansCommentaires(lire(BAND_COMMANDS));
    assert.match(code, /preference !== "2d" && verdictCapacites\(\{ \.\.\.capacitesDuPoste\(\), preference \}\)\.mode === "3d"/);
    assert.equal(/\bsonder\b/.test(code), false, "aucune sonde : le verdict des seules capacités (spéc. l.985)");
    assert.match(code, /vue3d \? \(/);
    assert.match(code, /navigate\("salle-controle", rootId\)/);
  });

  it("BandCommands3d : [Revoir cette demande] ouvre RevoirDialog par son contrat", () => {
    const code = sansCommentaires(lire(BAND_COMMANDS));
    assert.match(code, /<RevoirDialog rootId=\{rootId\} ouvert=\{ouvert\} onFermer=\{\(\) => setOuvert\(false\)\} \/>/);
    assert.match(code, /onClick=\{\(\) => setOuvert\(true\)\}/);
  });

  it("RevoirEntree : revoirEtat au montage, bouton seulement si l'accès est donné", () => {
    const code = sansCommentaires(lire(REVOIR_ENTREE));
    assert.match(code, /salle3dApi\.revoirEtat\(rootId, controller\.signal\)/);
    assert.match(code, /\}, \[rootId\]\);/);
    assert.match(code, /if \(etat === null\) return null;/);
    assert.match(code, /if \(!etat\.acces\) \{/);
    assert.match(code, /<RevoirDialog rootId=\{rootId\} ouvert=\{ouvert\} onFermer=\{\(\) => setOuvert\(false\)\} \/>/);
  });

  it("RevoirEntree : rien pour « salle-demande-en-cours », la phrase du refus pour « salle-fin-inconnue »", () => {
    const code = sansCommentaires(lire(REVOIR_ENTREE));
    assert.match(code, /if \(etat\.raison !== "salle-fin-inconnue"\) return null;/);
    assert.match(code, /\{libelleRefus\(etat\.raison\)\}/);
    assert.equal(/salle-demande-en-cours/.test(code), false, "aucune phrase ni aucun bouton pour une demande en cours");
  });

  it("aucun texte affichable écrit dans les composants : tout vient des modules de textes (T3d-b)", () => {
    const phrases = [TEXTES_REVOIR.partout.revoir, TEXTES_SALLE.partout.ouvrir, ...Object.values(TEXTES_REVOIR.partout.refus)];
    for (const fichier of [BAND_COMMANDS, REVOIR_ENTREE]) {
      const code = sansCommentaires(lire(fichier));
      for (const phrase of phrases) assert.equal(code.includes(phrase), false, `${fichier} : « ${phrase} » écrite en dur`);
    }
    assert.match(sansCommentaires(lire(BAND_COMMANDS)), /\{TEXTES_REVOIR\.partout\.revoir\}/);
    assert.match(sansCommentaires(lire(BAND_COMMANDS)), /\{TEXTES_SALLE\.partout\.ouvrir\}/);
    assert.match(sansCommentaires(lire(REVOIR_ENTREE)), /\{TEXTES\.partout\.revoir\}/);
  });
});
