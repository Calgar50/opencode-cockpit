// Script couleurs JP-14 (spécification §5.7.1, §5.7.4, JP-13, JP-14 ; plan d'exécution, fiche L5a) : palettes néon sombre et néon
// clair ; traits au moins 3:1 et textes au moins 4,5:1 contre le fond et la grille, en vision normale, en deutéranopie et en
// protanopie ; couleurs de même forme (faisceau figé et faisceau vivant) séparées ; échec du script sous chaque seuil ; grammaire
// « la forme d'abord ».
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CVD_MATRICES,
  colorDistance,
  contrastRatio,
  NEON_DECOR,
  NEON_GRAMMAIRE,
  NEON_MEME_FORME,
  NEON_PALETTES,
  NEON_SIGNE_FAISCEAU,
  NEON_TEXTES,
  NEON_TRAITS,
  type NeonPalette,
  type NeonTheme,
  type NeonToken,
  neonColorProblems,
  neonCssVariables,
  paletteProblems,
  parseHex,
  relativeLuminance,
  SEUIL_ECART,
  SEUIL_TEXTE,
  SEUIL_TRAIT,
  simulate,
  VISIONS,
} from "./shared/neon-palette.ts";

const THEMES: readonly NeonTheme[] = ["sombre", "clair"];

/** Teinte TSL (degrés), saturation et luminosité d'une couleur « #RRGGBB ». */
function hsl(color: string): { h: number; s: number; l: number } {
  const [r, g, b] = parseHex(color);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s, l };
}

const summary = (problems: ReturnType<typeof paletteProblems>) => problems.map((p) => [p.theme, p.vision, p.mesure, p.jeton, p.contre].join(" "));
const withToken = (theme: NeonTheme, token: NeonToken, color: string): NeonPalette => ({ ...NEON_PALETTES[theme], [token]: color });

describe("script couleurs JP-14", () => {
  it("les palettes néon sombre et néon clair passent : traits ≥ 3:1, textes ≥ 4,5:1, en vision normale, deutéranopie et protanopie", () => {
    assert.deepEqual(neonColorProblems(), []);
    for (const theme of THEMES) {
      const palette = NEON_PALETTES[theme];
      assert.deepEqual(Object.keys(palette).sort(), [...NEON_DECOR, ...NEON_TRAITS, ...NEON_TEXTES].sort(), `${theme} : chaque jeton est décor, trait ou texte`);
      for (const vision of VISIONS) {
        for (const decor of NEON_DECOR) {
          for (const trait of NEON_TRAITS) assert.ok(contrastRatio(palette[trait], palette[decor], vision) >= SEUIL_TRAIT, `${theme} ${vision} ${trait}/${decor}`);
          for (const texte of NEON_TEXTES) assert.ok(contrastRatio(palette[texte], palette[decor], vision) >= SEUIL_TEXTE, `${theme} ${vision} ${texte}/${decor}`);
        }
        for (const [a, b] of NEON_MEME_FORME) assert.ok(colorDistance(palette[a], palette[b], vision) >= SEUIL_ECART, `${theme} ${vision} ${a}/${b}`);
      }
    }
    assert.equal(SEUIL_TRAIT, 3);
    assert.equal(SEUIL_TEXTE, 4.5);
    assert.deepEqual(VISIONS, ["normale", "deuteranopie", "protanopie"]);
  });

  it("échec sous le seuil d'un trait, dans chaque thème, contre le fond ou contre la grille seule", () => {
    assert.deepEqual(summary(paletteProblems(withToken("sombre", "consigne", "#101826"), "sombre")), [
      "sombre normale contraste consigne fond",
      "sombre normale contraste consigne grille",
      "sombre deuteranopie contraste consigne fond",
      "sombre deuteranopie contraste consigne grille",
      "sombre protanopie contraste consigne fond",
      "sombre protanopie contraste consigne grille",
    ]);
    // Passe contre le fond, échoue contre la grille : la grille compte.
    for (const [theme, color] of [["sombre", "#636377"], ["clair", "#818195"]] as const) {
      const problems = paletteProblems(withToken(theme, "auto", color), theme);
      assert.ok(problems.length > 0, theme);
      assert.ok(problems.every((p) => p.mesure === "contraste" && p.jeton === "auto" && p.contre === "grille"), `${theme} : ${summary(problems)}`);
    }
  });

  it("échec d'un texte entre 3:1 et 4,5:1 : le seuil des textes n'est pas celui des traits", () => {
    for (const [theme, color] of [["sombre", "#7A7A7A"], ["clair", "#707070"]] as const) {
      const ratio = Math.min(...VISIONS.flatMap((v) => NEON_DECOR.map((d) => contrastRatio(color, NEON_PALETTES[theme][d], v))));
      assert.ok(ratio >= SEUIL_TRAIT && ratio < SEUIL_TEXTE, `${theme} ${color} : ${ratio}`);
      const problems = paletteProblems(withToken(theme, "texteDiscret", color), theme);
      assert.ok(problems.length > 0 && problems.every((p) => p.jeton === "texteDiscret" && p.seuil === SEUIL_TEXTE), `${theme} : ${summary(problems)}`);
      // La même couleur comme trait passe.
      assert.deepEqual(paletteProblems(withToken(theme, "territoire", color), theme), []);
    }
  });

  it("échec vu seulement par la simulation : protanopie seule (néon sombre), deutéranopie seule (néon clair)", () => {
    const protan = paletteProblems(withToken("sombre", "extension", "#BB5500"), "sombre");
    assert.ok(protan.length > 0);
    assert.ok(protan.every((p) => p.vision === "protanopie" && p.mesure === "contraste" && p.jeton === "extension"), summary(protan).join(" ; "));
    const deutan = paletteProblems(withToken("clair", "consigne", "#DD00AA"), "clair");
    assert.ok(deutan.length > 0);
    assert.ok(deutan.every((p) => p.vision === "deuteranopie" && p.mesure === "contraste" && p.jeton === "consigne"), summary(deutan).join(" ; "));
  });

  it("échec de l'écart entre un faisceau figé et un faisceau vivant de même forme : l'ancien gris se confondait avec le rose en deutéranopie", () => {
    assert.deepEqual(summary(paletteProblems(withToken("sombre", "arret", "#8C96A6"), "sombre")), ["sombre deuteranopie ecart arret consigne"]);
    assert.deepEqual(summary(paletteProblems(withToken("clair", "arret", "#5F6B7A"), "clair")), ["clair deuteranopie ecart arret consigne"]);
    // Contraste suffisant dans les deux cas : seul l'écart échoue.
    assert.ok(contrastRatio("#8C96A6", NEON_PALETTES.sombre.grille, "deuteranopie") >= SEUIL_TRAIT);
  });

  it("couleur mal écrite : RangeError, sans recopier la valeur", () => {
    for (const bad of ["#12345", "rouge", "#GG0000", "#0000001"]) {
      assert.throws(() => paletteProblems(withToken("sombre", "auto", bad), "sombre"), (error: unknown) => error instanceof RangeError && !error.message.includes(bad));
    }
  });
});

describe("mesures de couleur", () => {
  it("contraste WCAG : blanc sur noir 21:1, #767676 sur blanc 4,54:1, symétrique", () => {
    assert.equal(Math.round(contrastRatio("#FFFFFF", "#000000") * 100) / 100, 21);
    assert.equal(Math.round(contrastRatio("#767676", "#FFFFFF") * 100) / 100, 4.54);
    assert.equal(contrastRatio("#FF3DA6", "#070B14"), contrastRatio("#070B14", "#FF3DA6"));
  });

  it("simulation de Machado (sévérité 1) : gris inchangés, rouge assombri en protanopie et éclairci en deutéranopie, vert et rouge rapprochés", () => {
    for (const [vision, matrix] of Object.entries(CVD_MATRICES)) {
      for (const row of matrix) assert.ok(Math.abs(row[0] + row[1] + row[2] - 1) < 1e-5, `${vision} : une ligne vaut 1 pour un gris`);
      for (const gray of ["#000000", "#808080", "#FFFFFF"]) {
        const normal = simulate(gray, "normale");
        simulate(gray, vision as "protanopie").forEach((c, i) => assert.ok(Math.abs(c - (normal[i] ?? 0)) < 1e-5, `${vision} ${gray}`));
      }
    }
    const red = relativeLuminance(simulate("#FF0000", "normale"));
    assert.ok(relativeLuminance(simulate("#FF0000", "protanopie")) < red * 0.6);
    assert.ok(relativeLuminance(simulate("#FF0000", "deuteranopie")) > red * 1.2);
    assert.ok(colorDistance("#00B000", "#D00000", "deuteranopie") < colorDistance("#00B000", "#D00000", "normale") / 2);
  });
});

describe("grammaire « la forme d'abord » (§5.7.1)", () => {
  it("chaque signe a sa propre forme ; consigne rose à chevrons, résultat bleu à losanges, attente ambre à cadenas, décisions bouclier ou croix, arrêt gris", () => {
    const formes = Object.values(NEON_GRAMMAIRE).map((style) => style.forme);
    assert.equal(new Set(formes).size, formes.length);
    assert.match(NEON_GRAMMAIRE.consigne.forme, /chevrons/);
    assert.match(NEON_GRAMMAIRE.resultat.forme, /losanges/);
    assert.match(NEON_GRAMMAIRE.resultat.forme, /^pointille/);
    assert.match(NEON_GRAMMAIRE.consigne.forme, /^trait-plein/);
    assert.match(NEON_GRAMMAIRE.attente.forme, /^hexagone-hachure-cadenas$/);
    assert.match(NEON_GRAMMAIRE.auto.forme, /^bouclier-coche$/);
    assert.equal(NEON_GRAMMAIRE.refus.forme, "croix");
    assert.equal(NEON_GRAMMAIRE.termine.forme, "anneau-coche");
    assert.equal(NEON_GRAMMAIRE.echec.forme, "anneau-brise");
    for (const theme of THEMES) {
      const palette = NEON_PALETTES[theme];
      const hue = (token: NeonToken) => hsl(palette[token]).h;
      const inRange = (token: NeonToken, from: number, to: number) => {
        const h = hue(token);
        assert.ok(from <= to ? h >= from && h <= to : h >= from || h <= to, `${theme} ${token} : teinte ${h.toFixed(0)}`);
        assert.ok(hsl(palette[token]).s >= 0.5, `${theme} ${token} : saturée`);
      };
      inRange(NEON_GRAMMAIRE.consigne.trait, 310, 345); // rose
      inRange(NEON_GRAMMAIRE.resultat.trait, 200, 225); // bleu
      inRange(NEON_GRAMMAIRE.attente.trait, 30, 45); // ambre
      inRange(NEON_GRAMMAIRE.auto.trait, 120, 160); // vert
      inRange(NEON_GRAMMAIRE.refus.trait, 350, 5); // rouge
      inRange(NEON_GRAMMAIRE.extension.trait, 15, 30); // orange
      inRange("territoire", 180, 195); // cyan
      assert.ok(hsl(palette[NEON_GRAMMAIRE.arret.trait]).s < 0.2, `${theme} arrêt gris`);
    }
    assert.equal(NEON_PALETTES.sombre.fond, "#070B14");
    assert.equal(NEON_PALETTES.sombre.grille, "#13233A");
  });

  it("faisceau figé : il garde la forme de son faisceau, donc son gris est comparé à la couleur vivante de chaque faisceau", () => {
    const beamTraits = new Set(Object.values(NEON_SIGNE_FAISCEAU).map((signe) => NEON_GRAMMAIRE[signe].trait));
    assert.deepEqual(new Set(NEON_MEME_FORME.map(([, trait]) => trait)), beamTraits);
    assert.ok(NEON_MEME_FORME.every(([arret]) => arret === "arret"));
    assert.deepEqual([...beamTraits].sort(), ["consigne", "resultat", "vous"]);
    for (const kind of Object.keys(NEON_SIGNE_FAISCEAU)) assert.notEqual(NEON_GRAMMAIRE[NEON_SIGNE_FAISCEAU[kind as keyof typeof NEON_SIGNE_FAISCEAU]].forme, NEON_GRAMMAIRE.arret.forme);
  });

  it("variables CSS : un jeton par variable, dans les deux thèmes", () => {
    for (const theme of THEMES) {
      const variables = neonCssVariables(theme);
      assert.equal(Object.keys(variables).length, Object.keys(NEON_PALETTES[theme]).length);
      assert.equal(variables["--neon-texte-discret"], NEON_PALETTES[theme].texteDiscret);
      assert.equal(variables["--neon-fond"], NEON_PALETTES[theme].fond);
    }
  });
});
