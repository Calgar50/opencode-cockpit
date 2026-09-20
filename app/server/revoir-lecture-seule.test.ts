// Tests L28c, « Revoir » en lecture seule, prouvé STATIQUEMENT (spécification §5.9 l.1018-1024, §5.5 l.920, §6 l.1065 ; plan
// d'exécution it3, fiche L28c, D-3d-12, D-3d-29, U2, Q6). Lecture de source seulement : aucun navigateur, aucune dépendance.
// Commentaires ignorés ; le contenu des chaînes est gardé (un « aria-live » écrit dans une chaîne compte aussi).
// Règles :
//  1. web/pages/salle-controle/revoir/** n'importe ni web/lib/api.ts, ni web/lib/api-activity.ts, n'appelle ni fetch, ni oc.
//     (le client d'opencode) : « Revoir » ne relance rien et ne relit rien dans la conversation.
//  2. De NeonBand.tsx, revoir/** n'importe QUE NeonCarte et NeonTableau : la bande n'est jamais montée (D-3d-12), donc ni sa file
//     d'affichage, ni son « Affichage rattrapé », ni sa relecture des messages.
//  3. Requêtes : les fichiers de la BOÎTE (L28c) n'appellent que salle3dApi.revoir, .revoirConsigne et .revoirConsignesEnfant
//     (U2) ; les autres fichiers de revoir/** (entrées de L28b) peuvent en plus lire l'accès par .revoirEtat, qui est aussi une
//     lecture seule de /api/revoir. Rien d'autre du client de la salle, et surtout pas .territoires.
//  4. SubSessionDrawer (qui relit la conversation en direct) n'est jamais importé dans salle-controle/**.
//  5. Aucun attribut aria-live dans web/pages/salle-controle/** : une seule région d'annonces par page (D-3d-29). La règle couvre
//     aussi les fichiers des vagues suivantes.
//  6. useAnnouncer n'est appelé qu'avec ui.activityAnnouncements, jamais avec une constante (D-3d-29) : les annonces restent
//     coupables par le réglage.
// Chaque règle échoue sur un source fabriqué (contrôle discriminant).
// « Zéro requête à opencode pendant « Revoir », zoom 3 et [Voir la consigne] compris » est joué en e2e par L35 (réseau du
// navigateur) : ce test garde la propriété à la source.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const WEB_DIR = path.join(import.meta.dirname, "..", "web");
/** Périmètres, relatifs à web/. */
const SALLE = "pages/salle-controle";
const REVOIR = `${SALLE}/revoir`;

/** Fichiers de la BOÎTE « Revoir » (L28c) : leurs seules requêtes sont les trois lectures de la fiche. */
const BOITE: ReadonlySet<string> = new Set([
  `${REVOIR}/RevoirDialog.tsx`,
  `${REVOIR}/ReplayBar.tsx`,
  `${REVOIR}/LegendeBulle.tsx`,
  `${REVOIR}/PanneauRevoir.tsx`,
  `${REVOIR}/useReplay.ts`,
  `${REVOIR}/annonces-revoir.ts`,
]);

const API_BOITE: ReadonlySet<string> = new Set(["revoir", "revoirConsigne", "revoirConsignesEnfant"]);
/** Entrées de « Revoir » (L28b) : la même lecture, plus l'état d'accès (GET /api/revoir/:rootId?etat=1). */
const API_REVOIR: ReadonlySet<string> = new Set([...API_BOITE, "revoirEtat"]);

/** Clients de l'API interdits dans revoir/** : le client général (qui porte le proxy opencode) et celui de l'activité. */
const CLIENTS_INTERDITS = ["api.ts", "api-activity.ts"];

interface Source {
  /** Chemin relatif à web/, séparateur « / ». */
  fichier: string;
  texte: string;
}

interface Violation {
  fichier: string;
  regle: string;
  detail: string;
}

// --- Lecture du source ----------------------------------------------------------------------------------------------------------

/** Fin d'une chaîne ouverte en `debut` (guillemet simple, double ou accent grave), échappements compris. */
function finDeChaine(texte: string, debut: number, quote: string): number {
  let i = debut + 1;
  while (i < texte.length) {
    const c = texte[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (quote !== "`" && c === "\n") return i;
    i += 1;
  }
  return texte.length;
}

/** Source sans ses commentaires ; les chaînes sont gardées telles quelles (une chaîne qui contient « // » reste entière). */
function sansCommentaires(texte: string): string {
  let out = "";
  let i = 0;
  while (i < texte.length) {
    const c = texte[i] ?? "";
    const suivant = texte[i + 1];
    if (c === "/" && suivant === "/") {
      const fin = texte.indexOf("\n", i);
      i = fin === -1 ? texte.length : fin;
      continue;
    }
    if (c === "/" && suivant === "*") {
      const fin = texte.indexOf("*/", i + 2);
      i = fin === -1 ? texte.length : fin + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const fin = finDeChaine(texte, i, c);
      out += texte.slice(i, fin);
      i = fin;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Sources .ts et .tsx d'un dossier de web/, chemins relatifs à web/ ; liste vide si le dossier n'existe pas. */
function sourcesDe(relatif: string): Source[] {
  const racine = path.join(WEB_DIR, ...relatif.split("/"));
  if (!fs.existsSync(racine)) return [];
  const out: Source[] = [];
  const parcourir = (dossier: string, prefixe: string) => {
    for (const entree of fs.readdirSync(dossier, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const complet = path.join(dossier, entree.name);
      const chemin = `${prefixe}/${entree.name}`;
      if (entree.isDirectory()) parcourir(complet, chemin);
      else if (entree.name.endsWith(".ts") || entree.name.endsWith(".tsx")) out.push({ fichier: chemin, texte: fs.readFileSync(complet, "utf8") });
    }
  };
  parcourir(racine, relatif);
  return out;
}

/** Chemins importés d'un source (import statique, import type, import dynamique, export … from). */
function importsDe(code: string): string[] {
  return [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((m) => m[1] ?? "");
}

/** Noms importés d'un module donné (accolades seulement), `import type` compris. */
function nomsImportesDe(code: string, suffixeDuModule: string): string[] {
  const noms: string[] = [];
  for (const m of code.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    if (!(m[2] ?? "").endsWith(suffixeDuModule)) continue;
    for (const brut of (m[1] ?? "").split(",")) {
      const nom = brut.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim() ?? "";
      if (nom !== "") noms.push(nom);
    }
  }
  return noms;
}

/** Nom local sous lequel api-salle3d.ts est importé (salle3dApi), null si le module n'est pas importé. */
function nomDuClientSalle3d(code: string): string | null {
  for (const m of code.matchAll(/import\s+\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    if (!(m[2] ?? "").endsWith("api-salle3d.ts")) continue;
    for (const brut of (m[1] ?? "").split(",")) {
      const morceaux = brut.trim().split(/\s+as\s+/);
      const nom = (morceaux[1] ?? morceaux[0] ?? "").trim();
      if (nom !== "") return nom;
    }
  }
  return null;
}

// --- Règles ---------------------------------------------------------------------------------------------------------------------

/** Règles 1, 2 et 3 : périmètre revoir/**. */
function verifierRevoir(source: Source): Violation[] {
  const code = sansCommentaires(source.texte);
  const out: Violation[] = [];
  const ajouter = (regle: string, detail: string) => out.push({ fichier: source.fichier, regle, detail });

  for (const chemin of importsDe(code)) {
    const nomDeFichier = chemin.split("/").pop() ?? "";
    if (CLIENTS_INTERDITS.includes(nomDeFichier)) ajouter("client de l'API interdit dans « Revoir »", chemin);
  }
  if (/\bfetch\s*\(/.test(code)) ajouter("requête directe (fetch) dans « Revoir »", "fetch(");
  if (/\boc\s*\./.test(code)) ajouter("client du proxy opencode (oc.) dans « Revoir »", "oc.");

  const deLaBande = nomsImportesDe(code, "NeonBand.tsx");
  for (const nom of deLaBande) if (nom !== "NeonCarte" && nom !== "NeonTableau") ajouter("import de NeonBand.tsx autre que NeonCarte et NeonTableau", nom);

  const client = nomDuClientSalle3d(code);
  if (client !== null) {
    const permises = BOITE.has(source.fichier) ? API_BOITE : API_REVOIR;
    for (const m of code.matchAll(new RegExp(`\\b${client}\\s*\\.\\s*(\\w+)`, "g"))) {
      const membre = m[1] ?? "";
      if (!permises.has(membre)) ajouter("requête hors des lectures permises de « Revoir »", `${client}.${membre}`);
    }
  }
  return out;
}

/** Règles 4, 5 et 6 : périmètre salle-controle/**, fichiers des vagues suivantes compris. */
function verifierSalle(source: Source): Violation[] {
  const code = sansCommentaires(source.texte);
  const out: Violation[] = [];
  const ajouter = (regle: string, detail: string) => out.push({ fichier: source.fichier, regle, detail });

  if (/\bSubSessionDrawer\b/.test(code)) ajouter("SubSessionDrawer (relit la conversation en direct) dans la salle de contrôle", "SubSessionDrawer");
  if (/aria-live/.test(code)) ajouter("région aria-live propre : une seule région d'annonces par page (D-3d-29)", "aria-live");
  for (const m of code.matchAll(/useAnnouncer\s*\(([^)]*)\)/g)) {
    const argument = (m[1] ?? "").trim();
    if (argument !== "ui.activityAnnouncements") ajouter("useAnnouncer appelé avec autre chose que le réglage ui.activityAnnouncements", argument);
  }
  return out;
}

const lignes = (violations: readonly Violation[]) => violations.map((v) => `${v.fichier} : ${v.regle} (${v.detail})`).join("\n");
const fabrique = (fichier: string, texte: string): Source => ({ fichier, texte });

// --- Code réel ------------------------------------------------------------------------------------------------------------------

const SOURCES_REVOIR = sourcesDe(REVOIR);
const SOURCES_SALLE = sourcesDe(SALLE);

describe("« Revoir » en lecture seule : imports et requêtes de web/pages/salle-controle/revoir/", () => {
  it("le dossier revoir/ est bien parcouru (sinon la garde ne prouverait rien)", () => {
    assert.ok(SOURCES_REVOIR.length >= 3, SOURCES_REVOIR.map((s) => s.fichier).join(", "));
    for (const attendu of ["RevoirDialog.tsx", "ReplayBar.tsx", "LegendeBulle.tsx"]) {
      assert.ok(
        SOURCES_REVOIR.some((s) => s.fichier === `${REVOIR}/${attendu}`),
        attendu,
      );
    }
  });

  it("ni web/lib/api.ts, ni api-activity.ts, ni fetch, ni oc. ; de NeonBand.tsx, seulement NeonCarte et NeonTableau", () => {
    const violations = SOURCES_REVOIR.flatMap(verifierRevoir);
    assert.deepEqual(violations, [], lignes(violations));
  });

  it("la boîte « Revoir » lit vraiment les faits et la consigne gardée (U2), et rien d'autre", () => {
    const boite = SOURCES_REVOIR.filter((s) => BOITE.has(s.fichier))
      .map((s) => sansCommentaires(s.texte))
      .join("\n");
    assert.match(boite, /salle3dApi\s*\.\s*revoir\b/);
    assert.equal(/salle3dApi\s*\.\s*territoires\b/.test(boite), false);
  });

  it("DISCRIMINANT : chaque règle de revoir/** échoue sur un source fabriqué", () => {
    const cas: ReadonlyArray<[string, Source]> = [
      ["api.ts", fabrique(`${REVOIR}/Faux.tsx`, 'import { oc } from "../../../lib/api.ts";\n')],
      ["api-activity.ts", fabrique(`${REVOIR}/Faux.tsx`, 'import { activityApi } from "../../../lib/api-activity.ts";\n')],
      ["fetch", fabrique(`${REVOIR}/Faux.tsx`, "const r = await fetch('/api/oc/session');\n")],
      ["oc.", fabrique(`${REVOIR}/Faux.tsx`, "const m = await ocx.messages(id);\n".replace("ocx", "oc"))],
      ["NeonBand", fabrique(`${REVOIR}/Faux.tsx`, 'import { NeonBand, NeonCarte } from "../../chat/activity/NeonBand.tsx";\n')],
      [
        "api-salle3d",
        fabrique(`${REVOIR}/RevoirDialog.tsx`, 'import { salle3dApi } from "../../../lib/api-salle3d.ts";\nconst t = salle3dApi.territoires();\n'),
      ],
      [
        "revoirEtat dans la boîte",
        fabrique(`${REVOIR}/RevoirDialog.tsx`, 'import { salle3dApi } from "../../../lib/api-salle3d.ts";\nconst e = salle3dApi.revoirEtat(id);\n'),
      ],
    ];
    for (const [nom, source] of cas) assert.ok(verifierRevoir(source).length > 0, nom);
    // Témoins : ce que « Revoir » a le droit de faire ne lève rien.
    const permis = fabrique(
      `${REVOIR}/RevoirDialog.tsx`,
      'import { salle3dApi } from "../../../lib/api-salle3d.ts";\nimport { NeonCarte, NeonTableau } from "../../chat/activity/NeonBand.tsx";\nconst f = salle3dApi.revoir(id);\nconst c = salle3dApi.revoirConsigne(id, call);\nconst e = salle3dApi.revoirConsignesEnfant(id, enfant);\n',
    );
    assert.deepEqual(verifierRevoir(permis), []);
    // Une entrée de L28b (hors boîte) peut lire l'accès par revoirEtat.
    const entree = fabrique(`${REVOIR}/RevoirEntree.tsx`, 'import { salle3dApi } from "../../../lib/api-salle3d.ts";\nconst e = salle3dApi.revoirEtat(id);\n');
    assert.deepEqual(verifierRevoir(entree), []);
    // Un commentaire qui cite une règle ne la déclenche pas.
    const commentaire = fabrique(`${REVOIR}/Faux.tsx`, "// jamais fetch( ni oc. ici\n/* ni import de api.ts */\n");
    assert.deepEqual(verifierRevoir(commentaire), []);
  });
});

describe("salle de contrôle : une seule région d'annonces par page (D-3d-29)", () => {
  it("le dossier salle-controle/ est bien parcouru", () => {
    assert.ok(SOURCES_SALLE.length >= SOURCES_REVOIR.length, `${SOURCES_SALLE.length} sources`);
  });

  it("aucun aria-live, aucun SubSessionDrawer, useAnnouncer seulement avec ui.activityAnnouncements", () => {
    const violations = SOURCES_SALLE.flatMap(verifierSalle);
    assert.deepEqual(violations, [], lignes(violations));
  });

  it("les annonces de la salle passent bien par useAnnouncer (sinon la garde ne prouverait rien)", () => {
    const tout = SOURCES_SALLE.map((s) => sansCommentaires(s.texte)).join("\n");
    assert.match(tout, /useAnnouncer\s*\(\s*ui\.activityAnnouncements\s*\)/);
  });

  it("DISCRIMINANT : chaque règle de salle-controle/** échoue sur un source fabriqué", () => {
    const cas: ReadonlyArray<[string, Source]> = [
      ["aria-live", fabrique(`${SALLE}/Faux.tsx`, '<div aria-live="polite" />;\n')],
      ["SubSessionDrawer", fabrique(`${SALLE}/Faux.tsx`, 'import { SubSessionDrawer } from "../chat/SubSessionDrawer.tsx";\n')],
      ["useAnnouncer constant", fabrique(`${SALLE}/Faux.tsx`, "const say = useAnnouncer(true);\n")],
    ];
    for (const [nom, source] of cas) assert.ok(verifierSalle(source).length > 0, nom);
    assert.deepEqual(verifierSalle(fabrique(`${SALLE}/Faux.tsx`, "const say = useAnnouncer(ui.activityAnnouncements);\n")), []);
    assert.deepEqual(verifierSalle(fabrique(`${SALLE}/Faux.tsx`, "// aucune région aria-live ici, et SubSessionDrawer n'est jamais importé\n")), []);
  });
});
