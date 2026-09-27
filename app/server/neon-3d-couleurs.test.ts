// Script couleurs de la salle de contrôle 3D (L33 ; spécification §5.7.1 l.946 « couleurs » JP-14, §5.5 l.919-921, §5.8 l.996-998 ;
// plan d'exécution it3, fiche L33 ; D-3d-07 : `neon-palette.ts` n'est PAS modifié, ses fonctions de contrôle sont reprises).
//
// Ce que la 3D pose de plus que la carte 2D, et que ce script mesure :
//   - les ÉTIQUETTES DOM de la scène (Etiquettes3d) sont posées SUR la scène, fond opaque au jeton `fond` et texte au jeton
//     `texte` : le texte doit tenir 4,5:1 contre ce fond (§5.5 l.919, texte) ;
//   - les PLAQUES des territoires (jeton `territoire`) et l'ENCEINTE de la Salle OMO (jeton `extension`, JP-10) sont des traits
//     lumineux sur le fond de la scène, que le moteur efface au jeton `fond` : au moins 3:1 contre lui.
// Les deux thèmes (néon sombre et néon clair), en vision normale, en deutéranopie et en protanopie (simulation de Machado
// reprise de neon-palette.ts) ; le script échoue sous le seuil, et chaque règle est éprouvée sur une palette fabriquée.
//
// Le script vérifie aussi que ces jetons sont bien ceux que la 3D emploie (lecture statique d'Etiquettes3d.tsx, three/graphe.ts et
// three/moteur.ts) : sans cela, les seuils mesureraient des couleurs que la scène n'utilise pas.
//
// Enfin, l'ACCESSIBILITÉ des quatre feuilles de la salle (§5.5 l.921-922) : chacune porte un bloc
// `@media (forced-colors: active)` et un bloc de mouvement réduit ; sous couleurs forcées, aucune couleur écrite n'est autre
// qu'une couleur système, et les deux portées qui montrent la carte néon HORS de `.neon-band` (`.zoom-conv` du zoom 2,
// `.revoir-boite` de « Revoir ») redéfinissent TOUS les jetons `--neon-*` — sans quoi la règle générale
// `.neon-map { forced-color-adjust: none }` de neon.css leur laisserait les couleurs néon en mode contrasté.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  contrastRatio,
  NEON_PALETTES,
  neonCssVariables,
  type NeonPalette,
  type NeonTheme,
  type NeonToken,
  paletteProblems,
  SEUIL_TEXTE,
  SEUIL_TRAIT,
  type Vision,
  VISIONS,
} from "./shared/neon-palette.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const SALLE = "web/pages/salle-controle";
const THEMES: readonly NeonTheme[] = ["sombre", "clair"];

// --- 1. Couleurs de la scène 3D (JP-14) ------------------------------------------------------------------------------------------

/** Un contraste exigé par la scène 3D : un jeton, ce sur quoi il est posé, et son seuil. */
interface Regle3d {
  /** Ce que la scène en fait, en clair : sert au message d'échec. */
  quoi: string;
  jeton: NeonToken;
  contre: NeonToken;
  seuil: number;
}

/**
 * Les trois contrastes propres à la 3D (fiche L33). Le fond de la scène est celui que le moteur efface (`setClearColor`) et
 * celui des étiquettes : c'est le même jeton, donc la même mesure vaut sur la scène et sur l'étiquette.
 */
const REGLES_3D: readonly Regle3d[] = [
  { quoi: "texte d'une étiquette DOM sur son fond opaque", jeton: "texte", contre: "fond", seuil: SEUIL_TEXTE },
  { quoi: "arêtes d'une plaque de territoire sur le fond de la scène", jeton: "territoire", contre: "fond", seuil: SEUIL_TRAIT },
  { quoi: "enceinte de la Salle OMO sur le fond de la scène", jeton: "extension", contre: "fond", seuil: SEUIL_TRAIT },
];

interface Probleme3d {
  theme: NeonTheme;
  vision: Vision;
  quoi: string;
  jeton: NeonToken;
  contre: NeonToken;
  valeur: number;
  seuil: number;
}

/** Manquements de la 3D pour une palette : vide si elle passe, dans les trois visions. */
function problemes3d(palette: NeonPalette, theme: NeonTheme): Probleme3d[] {
  const problemes: Probleme3d[] = [];
  for (const vision of VISIONS) {
    for (const regle of REGLES_3D) {
      const valeur = contrastRatio(palette[regle.jeton], palette[regle.contre], vision);
      if (valeur < regle.seuil) problemes.push({ theme, vision, quoi: regle.quoi, jeton: regle.jeton, contre: regle.contre, valeur, seuil: regle.seuil });
    }
  }
  return problemes;
}

/** Script couleurs 3D sur les deux palettes livrées : vide si toutes deux passent. */
function problemesScene3d(): Probleme3d[] {
  return THEMES.flatMap((theme) => problemes3d(NEON_PALETTES[theme], theme));
}

const resume3d = (problemes: readonly Probleme3d[]) => problemes.map((p) => `${p.theme} ${p.vision} ${p.jeton}/${p.contre}`);
const avecJeton = (theme: NeonTheme, jeton: NeonToken, couleur: string): NeonPalette => ({ ...NEON_PALETTES[theme], [jeton]: couleur });

describe("couleurs de la salle de contrôle 3D (JP-14)", () => {
  it("les deux palettes passent : étiquettes ≥ 4,5:1, territoire et enceinte ≥ 3:1 sur le fond, en vision normale, deutéranopie et protanopie", () => {
    assert.deepEqual(problemesScene3d(), []);
    // Les valeurs sont recalculées ici sans passer par problemes3d : le script ne peut pas être vert parce qu'il ne mesure rien.
    for (const theme of THEMES) {
      const palette = NEON_PALETTES[theme];
      for (const vision of VISIONS) {
        assert.ok(contrastRatio(palette.texte, palette.fond, vision) >= 4.5, `${theme} ${vision} : étiquette`);
        assert.ok(contrastRatio(palette.territoire, palette.fond, vision) >= 3, `${theme} ${vision} : territoire`);
        assert.ok(contrastRatio(palette.extension, palette.fond, vision) >= 3, `${theme} ${vision} : enceinte`);
      }
    }
    assert.equal(REGLES_3D.length, 3);
    assert.deepEqual(VISIONS, ["normale", "deuteranopie", "protanopie"]);
    assert.deepEqual([SEUIL_TEXTE, SEUIL_TRAIT], [4.5, 3]);
  });

  it("la fonction de contrôle exportée par neon-palette.ts (D-3d-07) est verte sur les mêmes palettes", () => {
    for (const theme of THEMES) assert.deepEqual(paletteProblems(NEON_PALETTES[theme], theme), [], theme);
  });

  it("échec sous le seuil des étiquettes : un fond trop proche du texte, dans les deux thèmes et dans les trois visions", () => {
    // Un seul gris suffit aux deux thèmes : il est trop proche du texte clair du thème sombre ET du texte sombre du thème clair.
    const fond = "#757575";
    for (const theme of THEMES) {
      const problemes = problemes3d(avecJeton(theme, "fond", fond), theme);
      const surLetiquette = problemes.filter((p) => p.jeton === "texte");
      assert.equal(surLetiquette.length, VISIONS.length, `${theme} : ${resume3d(problemes)}`);
      assert.ok(
        surLetiquette.every((p) => p.seuil === SEUIL_TEXTE && p.valeur < SEUIL_TEXTE),
        `${theme} : ${resume3d(surLetiquette)}`,
      );
    }
  });

  it("échec entre 3:1 et 4,5:1 : l'étiquette tombe là où un trait passerait encore", () => {
    for (const [theme, texte] of [
      ["sombre", "#6A6A6A"],
      ["clair", "#808080"],
    ] as const) {
      const palette = avecJeton(theme, "texte", texte);
      const contraste = VISIONS.map((vision) => contrastRatio(texte, palette.fond, vision));
      assert.ok(Math.min(...contraste) >= SEUIL_TRAIT && Math.max(...contraste) < SEUIL_TEXTE, `${theme} : ${contraste.map((v) => v.toFixed(2)).join(", ")}`);
      const problemes = problemes3d(palette, theme);
      assert.equal(problemes.length, VISIONS.length, `${theme} : ${resume3d(problemes)}`);
      assert.ok(
        problemes.every((p) => p.jeton === "texte" && p.seuil === SEUIL_TEXTE),
        `${theme} : ${resume3d(problemes)}`,
      );
      // La même couleur passerait comme trait : c'est bien le seuil des textes qui tranche.
      assert.deepEqual(problemes3d(avecJeton(theme, "territoire", texte), theme), [], `${theme} : trait au même gris`);
    }
  });

  it("échec du territoire et de l'enceinte sous 3:1, chacun pour son propre jeton", () => {
    for (const jeton of ["territoire", "extension"] as const) {
      const problemes = problemes3d(avecJeton("sombre", jeton, "#101826"), "sombre");
      assert.equal(problemes.length, VISIONS.length, `${jeton} : ${resume3d(problemes)}`);
      assert.ok(
        problemes.every((p) => p.jeton === jeton && p.contre === "fond" && p.seuil === SEUIL_TRAIT),
        `${jeton} : ${resume3d(problemes)}`,
      );
    }
  });

  it("échec vu par la seule simulation : une enceinte que la vision normale accepte et que la protanopie refuse", () => {
    // Rouge vif sur le fond du néon sombre : 4,41:1 en vision normale, 5,50:1 en deutéranopie, 2,79:1 en protanopie.
    const palette = avecJeton("sombre", "extension", "#F0000C");
    assert.ok(contrastRatio(palette.extension, palette.fond, "normale") >= SEUIL_TRAIT, "acceptée en vision normale");
    assert.ok(contrastRatio(palette.extension, palette.fond, "deuteranopie") >= SEUIL_TRAIT, "acceptée en deutéranopie");
    const problemes = problemes3d(palette, "sombre");
    assert.ok(problemes.length > 0, "aucun manquement relevé : la simulation ne sert à rien");
    assert.ok(
      problemes.every((p) => p.vision === "protanopie" && p.jeton === "extension"),
      resume3d(problemes).join(" ; "),
    );
  });

  it("couleur mal écrite : RangeError, sans recopier la valeur", () => {
    for (const mauvaise of ["#12345", "canvastext", "#GG0000"]) {
      assert.throws(
        () => problemes3d(avecJeton("sombre", "fond", mauvaise), "sombre"),
        (erreur: unknown) => erreur instanceof RangeError && !erreur.message.includes(mauvaise),
      );
    }
  });
});

// --- 2. Les jetons mesurés sont bien ceux que la 3D emploie ----------------------------------------------------------------------

const lire = (relatif: string) => fs.readFileSync(path.join(APP_DIR, relatif), "utf8");

describe("les jetons mesurés sont ceux de la scène 3D", () => {
  it("Etiquettes3d pose le fond au jeton `fond` et le texte au jeton `texte` de la palette", () => {
    const source = lire(`${SALLE}/Etiquettes3d.tsx`);
    assert.match(source, /const\s+palette\s*=\s*NEON_PALETTES\[theme\];/, "la palette vient de neon-palette.ts");
    assert.match(source, /const\s*\{\s*fond,\s*texte:\s*couleurDuTexte\s*\}\s*=\s*palette;/, "fond et texte lus dans la palette");
    assert.match(source, /background:\s*fond,\s*color:\s*couleurDuTexte/, "le bouton prend ce fond et ce texte");
  });

  it("le graphe three prend `territoire` pour les plaques et `extension` pour l'enceinte de la Salle OMO", () => {
    const source = lire(`${SALLE}/three/graphe.ts`);
    assert.match(source, /JETON_STATION:\s*NeonToken\s*=\s*"territoire"/);
    assert.match(source, /JETON_ENCEINTE:\s*NeonToken\s*=\s*"extension"/);
    assert.match(source, /materiauLigne\(atelier,\s*"territoire"\)/, "les arêtes d'une plaque sont au jeton territoire");
  });

  it("le moteur efface la scène au jeton `fond` : c'est bien ce fond que les seuils mesurent", () => {
    assert.match(lire(`${SALLE}/three/moteur.ts`), /setClearColor\(palette\.fond/);
  });
});

// --- 3. Feuilles de la salle : couleurs forcées et mouvement réduit (§5.5 l.921-922) ----------------------------------------------

/** Feuilles de la salle que L33 complète, relatives à app/. */
const FEUILLES = [`${SALLE}/salle-controle.css`, `${SALLE}/zoom-conversation.css`, `${SALLE}/revoir/revoir.css`, `${SALLE}/revoir/consigne-revoir.css`] as const;

/**
 * Portées qui montrent la carte néon SANS le parent `.neon-band` : neon.css ne redéfinit ses jetons que sous ce parent, et sa
 * règle générale `.neon-map { forced-color-adjust: none }` ferait garder les couleurs néon en mode contrasté. Chacune doit donc
 * redéfinir TOUS les jetons.
 */
const PORTEES_NEON: Readonly<Record<string, string>> = {
  [`${SALLE}/zoom-conversation.css`]: ".zoom-conv",
  [`${SALLE}/revoir/revoir.css`]: ".revoir-boite",
};

/** Jetons de la palette, tels que styles.css les écrit (`--neon-<jeton>`) : la liste vient de neon-palette.ts, jamais d'ici. */
const JETONS_CSS = Object.keys(neonCssVariables("sombre")).sort();

/** Couleurs système permises sous `forced-colors: active` (CSS Color 4, couleurs système) et mots neutres. */
const COULEURS_SYSTEME = new Set([
  "canvas",
  "canvastext",
  "linktext",
  "visitedtext",
  "activetext",
  "buttonface",
  "buttontext",
  "buttonborder",
  "field",
  "fieldtext",
  "highlight",
  "highlighttext",
  "selecteditem",
  "selecteditemtext",
  "mark",
  "marktext",
  "graytext",
  "accentcolor",
  "accentcolortext",
  "currentcolor",
  "transparent",
]);

/** Valeurs de couleur interdites dans un bloc de couleurs forcées : teinte écrite, fonction de couleur, jeton de thème. */
const COULEUR_ECRITE = /#[0-9A-Fa-f]{3,8}\b|\b(?:rgba?|hsla?|color|oklch|lab)\s*\(|var\(\s*--/;

interface FeuilleCss {
  fichier: string;
  texte: string;
}

const sansCommentaires = (texte: string) => texte.replace(/\/\*[\s\S]*?\*\//g, (bloc) => bloc.replace(/[^\n]/g, " "));

/** Déclarations d'une feuille, avec les en-têtes des blocs qui les contiennent (même lexique que salle3d-animations.test.ts). */
function declarations(code: string): Array<{ prop: string; valeur: string; blocs: string[] }> {
  const sortie: Array<{ prop: string; valeur: string; blocs: string[] }> = [];
  const pile: string[] = [];
  let tampon = "";
  const vider = () => {
    const trouve = /^\s*([\w-]+)\s*:([\s\S]*)$/.exec(tampon);
    if (trouve && pile.length > 0) sortie.push({ prop: (trouve[1] ?? "").toLowerCase(), valeur: (trouve[2] ?? "").trim(), blocs: [...pile] });
  };
  for (const caractere of code) {
    if (caractere === "{") {
      pile.push(tampon.trim());
      tampon = "";
    } else if (caractere === ";" || caractere === "}") {
      vider();
      if (caractere === "}") pile.pop();
      tampon = "";
    } else {
      tampon += caractere;
    }
  }
  return sortie;
}

const dansCouleursForcees = (blocs: readonly string[]) => blocs.some((bloc) => /^@media\b/.test(bloc) && /forced-colors\s*:\s*active/i.test(bloc));
const dansMouvementReduit = (blocs: readonly string[]) => blocs.some((bloc) => /^@media\b/.test(bloc) && /prefers-reduced-motion\s*:\s*reduce/i.test(bloc));
/** Vrai si l'un des sélecteurs du bloc le plus proche vise exactement cette portée. */
const viseLaPortee = (blocs: readonly string[], portee: string) =>
  (blocs.at(-1) ?? "")
    .split(",")
    .map((selecteur) => selecteur.trim())
    .includes(portee);

/** Manquements des feuilles de la salle, triés ; vide si elles passent. */
function problemesCss(feuilles: readonly FeuilleCss[]): string[] {
  const problemes: string[] = [];
  for (const { fichier, texte } of feuilles) {
    const decls = declarations(sansCommentaires(texte));
    if (!decls.some((d) => dansCouleursForcees(d.blocs))) problemes.push(`${fichier} : aucun bloc @media (forced-colors: active)`);
    if (!decls.some((d) => dansMouvementReduit(d.blocs))) problemes.push(`${fichier} : aucun bloc de mouvement réduit`);

    for (const decl of decls.filter((d) => dansCouleursForcees(d.blocs))) {
      if (COULEUR_ECRITE.test(decl.valeur)) problemes.push(`${fichier} : couleur non système sous couleurs forcées (${decl.prop})`);
    }
    for (const decl of decls.filter((d) => dansMouvementReduit(d.blocs))) {
      if ((decl.prop === "animation" || decl.prop === "animation-name") && decl.valeur.toLowerCase() !== "none") {
        problemes.push(`${fichier} : animation déclarée sous mouvement réduit (${decl.prop})`);
      }
    }

    const portee = PORTEES_NEON[fichier];
    if (portee === undefined) continue;
    const jetons = decls.filter((d) => dansCouleursForcees(d.blocs) && viseLaPortee(d.blocs, portee) && d.prop.startsWith("--neon-"));
    const manquants = JETONS_CSS.filter((jeton) => !jetons.some((d) => d.prop === jeton));
    if (manquants.length > 0) problemes.push(`${fichier} : jeton(s) néon non redéfini(s) sous ${portee} : ${manquants.join(", ")}`);
    for (const jeton of jetons) {
      if (!COULEURS_SYSTEME.has(jeton.valeur.toLowerCase())) problemes.push(`${fichier} : ${jeton.prop} n'est pas une couleur système sous ${portee}`);
    }
  }
  return problemes.sort();
}

describe("feuilles de la salle : couleurs forcées et mouvement réduit — contrôles discriminants", () => {
  const complet = (portee: string) => `@media (forced-colors: active) { ${portee} { ${JETONS_CSS.map((jeton) => `${jeton}: CanvasText;`).join(" ")} } }`;
  const reduit = "@media (prefers-reduced-motion: reduce) { .x { transition: none; } }";
  const feuille = (texte: string, fichier = `${SALLE}/salle-controle.css`): FeuilleCss => ({ fichier, texte });

  it("une feuille sans bloc de couleurs forcées, ou sans bloc de mouvement réduit, est relevée", () => {
    assert.deepEqual(problemesCss([feuille(reduit)]), [`${SALLE}/salle-controle.css : aucun bloc @media (forced-colors: active)`]);
    assert.deepEqual(problemesCss([feuille("@media (forced-colors: active) { .x { border-color: CanvasText; } }")]), [`${SALLE}/salle-controle.css : aucun bloc de mouvement réduit`]);
    assert.deepEqual(problemesCss([feuille(`@media (forced-colors: active) { .x { border-color: CanvasText; } } ${reduit}`)]), []);
  });

  it("une couleur écrite ou un jeton de thème sous couleurs forcées est relevé ; hors du bloc, il ne l'est pas", () => {
    for (const valeur of ["#2EE6FF", "rgb(0 0 0)", "var(--border)"]) {
      assert.deepEqual(problemesCss([feuille(`@media (forced-colors: active) { .x { border-color: ${valeur}; } } ${reduit}`)]), [
        `${SALLE}/salle-controle.css : couleur non système sous couleurs forcées (border-color)`,
      ]);
    }
    assert.deepEqual(problemesCss([feuille(`.x { border-color: var(--border); } @media (forced-colors: active) { .x { border-color: CanvasText; } } ${reduit}`)]), []);
    // Un commentaire qui cite une teinte ne compte pas.
    assert.deepEqual(problemesCss([feuille(`@media (forced-colors: active) { /* #2EE6FF */ .x { border-color: CanvasText; } } ${reduit}`)]), []);
  });

  it("une animation déclarée sous mouvement réduit est relevée ; « none » est permis", () => {
    assert.deepEqual(problemesCss([feuille(`@media (forced-colors: active) { .x { border-color: CanvasText; } } @media (prefers-reduced-motion: reduce) { .x { animation: pulse 2s 1; } }`)]), [
      `${SALLE}/salle-controle.css : animation déclarée sous mouvement réduit (animation)`,
    ]);
    assert.deepEqual(problemesCss([feuille(`@media (forced-colors: active) { .x { border-color: CanvasText; } } @media (prefers-reduced-motion: reduce) { .x { animation: none; } }`)]), []);
  });

  it("une portée de carte néon qui oublie un jeton, ou le pose à une couleur écrite, est relevée", () => {
    const fichier = `${SALLE}/zoom-conversation.css`;
    assert.deepEqual(problemesCss([feuille(`${complet(".zoom-conv")} ${reduit}`, fichier)]), []);
    const sansUn = complet(".zoom-conv").replace("--neon-arret: CanvasText;", "");
    assert.deepEqual(problemesCss([feuille(`${sansUn} ${reduit}`, fichier)]), [`${fichier} : jeton(s) néon non redéfini(s) sous .zoom-conv : --neon-arret`]);
    const mauvaise = complet(".zoom-conv").replace("--neon-arret: CanvasText;", "--neon-arret: #6B778A;");
    assert.deepEqual(problemesCss([feuille(`${mauvaise} ${reduit}`, fichier)]), [
      `${fichier} : --neon-arret n'est pas une couleur système sous .zoom-conv`,
      `${fichier} : couleur non système sous couleurs forcées (--neon-arret)`,
    ]);
    // Les mêmes jetons posés sur une AUTRE portée ne couvrent pas la carte de la salle.
    assert.deepEqual(problemesCss([feuille(`${complet(".neon-band")} ${reduit}`, fichier)]), [
      `${fichier} : jeton(s) néon non redéfini(s) sous .zoom-conv : ${JETONS_CSS.join(", ")}`,
    ]);
    // Une portée écrite dans une liste de sélecteurs compte.
    assert.deepEqual(problemesCss([feuille(`${complet(".zoom-conv, .autre")} ${reduit}`, fichier)]), []);
  });

  it("une feuille sans portée de carte néon n'a pas de jeton à redéfinir", () => {
    const fichier = `${SALLE}/revoir/consigne-revoir.css`;
    assert.deepEqual(problemesCss([feuille(`@media (forced-colors: active) { .consigne-revoir { border-color: CanvasText; } } ${reduit}`, fichier)]), []);
  });
});

describe("feuilles de la salle : les quatre feuilles réelles", () => {
  const feuilles = FEUILLES.map((fichier) => ({ fichier, texte: lire(fichier) }));

  it("chaque feuille porte ses deux blocs, n'y écrit que des couleurs système, et la carte néon de la salle y passe en couleurs système", () => {
    assert.equal(feuilles.length, 4);
    assert.deepEqual(problemesCss(feuilles), []);
  });

  it("les portées de la carte néon redéfinissent les 14 jetons de la palette, liste prise dans neon-palette.ts", () => {
    assert.equal(JETONS_CSS.length, Object.keys(NEON_PALETTES.sombre).length);
    for (const [fichier, portee] of Object.entries(PORTEES_NEON)) {
      const texte = feuilles.find((f) => f.fichier === fichier)?.texte ?? "";
      for (const jeton of JETONS_CSS) assert.ok(new RegExp(`${jeton}\\s*:`).test(texte), `${fichier} : ${jeton} attendu sous ${portee}`);
    }
  });
});
