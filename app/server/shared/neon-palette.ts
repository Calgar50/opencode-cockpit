// Couleurs de la carte des agents en direct (spécification §5.7.1, §5.7.4, JP-13, JP-14 ; plan d'exécution, fiche L5a) : palettes
// « néon sombre » (thème sombre) et « néon clair » (thème clair), grammaire « la forme d'abord » et script couleurs JP-14.
// - Grammaire : chaque signe a une forme qui lui est propre ; la couleur la double (couleurs forcées, niveaux de gris, daltonisme).
//   Seul le faisceau figé par un arrêt garde la forme de son faisceau (chevrons, losanges) : il y ajoute la marque d'arrêt, et sa
//   couleur grise doit rester distincte de la couleur vivante de ce faisceau (NEON_MEME_FORME). Aucune taille ni épaisseur ici :
//   elles sont constantes (neon-scene.ts, NEON_TAILLES).
// - Script couleurs (paletteProblems) : contraste WCAG 2.x des traits (au moins 3:1) et des textes (au moins 4,5:1) contre le fond
//   ET la grille ; écart CIE 1976 d'au moins 15 entre deux couleurs qui partagent une forme. En vision normale, en deutéranopie et
//   en protanopie (Machado, Oliveira et Fernandes 2009, sévérité 1, appliqués en RVB linéaire), dans les deux thèmes.
//   Mesure du 17/09 : un écart d'au moins 15 entre TOUS les signes voisins est impossible en néon clair (rouge, orange, ambre et
//   vert se replient sur un même jaune-brun en deutéranopie, sous le plafond de luminosité du contraste 3:1) ; leurs formes les
//   distinguent. L'ancien gris d'arrêt (#8C96A6, #5F6B7A) se confondait avec le rose de la consigne en deutéranopie (écart 7 et 8).
// - Salle OMO (fiche L25b, JP-10, JP-14) : l'orange de l'extension trace l'enceinte (double trait, statique) et la boucle « par
//   l'extension ». Il partage une forme avec deux signes cyan (NEON_MEME_FORME_SALLE) : le contour de l'enceinte avec celui des
//   territoires, le cercle de la marque « relance par l'extension » avec celui des autres marques d'origine ; le script exige
//   entre eux l'écart de 15. Mesure du 23/09 : écart minimal 62,7 (néon clair, protanopie), contraste minimal 3,64:1 (grille du
//   néon clair, deutéranopie). L'orange et l'ambre de l'attente se confondent en néon clair et en deutéranopie (écart 1) : leurs
//   formes (boucle, hexagone hachuré à cadenas) les distinguent, comme le dit la mesure du 17/09.
// Module pur (server/shared) : aucun module node, aucun accès à l'environnement, ni horloge ni aléa.
import type { NeonBeamKind } from "./neon-scene.ts";

export type NeonTheme = "sombre" | "clair";

/** Jetons de couleur d'une palette. « acteur » : assistants et appels d'IA (cyan) ; « vous » : faisceau de votre demande. */
export type NeonToken =
  | "fond"
  | "grille"
  | "territoire"
  | "texte"
  | "texteDiscret"
  | "vous"
  | "consigne"
  | "resultat"
  | "attente"
  | "auto"
  | "refus"
  | "extension"
  | "acteur"
  | "arret";

export type NeonPalette = Readonly<Record<NeonToken, string>>;

/** Jetons de décor : jamais un signe. */
export const NEON_DECOR: readonly NeonToken[] = Object.freeze(["fond", "grille"]);
/** Jetons des traits et des formes : au moins 3:1 contre le fond et la grille. */
export const NEON_TRAITS: readonly NeonToken[] = Object.freeze(["territoire", "vous", "consigne", "resultat", "attente", "auto", "refus", "extension", "acteur", "arret"]);
/** Jetons des textes : au moins 4,5:1 contre le fond et la grille. Un texte ne s'écrit jamais dans une couleur de trait. */
export const NEON_TEXTES: readonly NeonToken[] = Object.freeze(["texte", "texteDiscret"]);

/**
 * Palettes. Néon sombre : fond `#070B14` et grille `#13233A` fixés par la spécification (§5.7.1) ; rose, bleu, ambre, vert, rouge,
 * orange, cyan et gris. Néon clair (§5.7.4) : mêmes teintes, foncées pour tenir 3:1 sur un fond clair.
 */
export const NEON_PALETTES: Readonly<Record<NeonTheme, NeonPalette>> = Object.freeze({
  sombre: Object.freeze({
    fond: "#070B14",
    grille: "#13233A",
    territoire: "#2EE6FF",
    texte: "#E8EEF7",
    texteDiscret: "#9AA8BD",
    vous: "#F2F5FA",
    consigne: "#FF3DA6",
    resultat: "#3DA9FF",
    attente: "#FFB02E",
    auto: "#3DFF9A",
    refus: "#FF5A5A",
    extension: "#FF8A3D",
    acteur: "#2EE6FF",
    arret: "#6B778A",
  }),
  clair: Object.freeze({
    fond: "#F5F7FB",
    grille: "#D9E1EC",
    territoire: "#007C91",
    texte: "#0B1220",
    texteDiscret: "#46546A",
    vous: "#1A2233",
    consigne: "#C2187A",
    resultat: "#1560BD",
    attente: "#9A6400",
    auto: "#137A45",
    refus: "#9E1C1C",
    extension: "#B34700",
    acteur: "#007C91",
    arret: "#414953",
  }),
});

/** Signes de la carte (§5.7.1). « extension » et « enceinte » : Salle OMO seulement (L25). */
export type NeonSign =
  | "demande"
  | "preparation"
  | "consigne"
  | "resultat"
  | "attente"
  | "auto"
  | "refus"
  | "extension"
  | "enceinte"
  | "appel"
  | "travaille"
  | "termine"
  | "echec"
  | "arret";

export interface NeonSignStyle {
  /** Forme propre au signe : deux signes n'ont jamais la même (la couleur n'est jamais le seul code). */
  forme: string;
  trait: NeonToken;
}

/** Grammaire, la forme d'abord (§5.7.1). Le halo reste statique en 2D (JP-13). */
export const NEON_GRAMMAIRE: Readonly<Record<NeonSign, Readonly<NeonSignStyle>>> = Object.freeze({
  demande: Object.freeze({ forme: "trait-plein-fleche", trait: "vous" }),
  preparation: Object.freeze({ forme: "pointille-fixe", trait: "consigne" }),
  consigne: Object.freeze({ forme: "trait-plein-chevrons", trait: "consigne" }),
  resultat: Object.freeze({ forme: "pointille-losanges", trait: "resultat" }),
  attente: Object.freeze({ forme: "hexagone-hachure-cadenas", trait: "attente" }),
  auto: Object.freeze({ forme: "bouclier-coche", trait: "auto" }),
  refus: Object.freeze({ forme: "croix", trait: "refus" }),
  extension: Object.freeze({ forme: "fleche-circulaire-mention", trait: "extension" }),
  /** Enceinte de la Salle OMO (JP-10) : double trait autour de la carte, statique (JP-13). */
  enceinte: Object.freeze({ forme: "double-trait-enceinte", trait: "extension" }),
  appel: Object.freeze({ forme: "impulsion", trait: "acteur" }),
  travaille: Object.freeze({ forme: "halo-statique", trait: "acteur" }),
  termine: Object.freeze({ forme: "anneau-coche", trait: "acteur" }),
  echec: Object.freeze({ forme: "anneau-brise", trait: "acteur" }),
  /** Marque ajoutée à un faisceau figé, qui garde la forme de son faisceau (NEON_SIGNE_FAISCEAU) et prend ce trait. */
  arret: Object.freeze({ forme: "carre-arret", trait: "arret" }),
});

/** Signe de chaque faisceau de la scène. */
export const NEON_SIGNE_FAISCEAU: Readonly<Record<NeonBeamKind, NeonSign>> = Object.freeze({
  demande: "demande",
  preparation: "preparation",
  consigne: "consigne",
  resultat: "resultat",
});

/** Couleurs qui partagent une forme : le gris d'un faisceau figé et la couleur vivante de chaque faisceau. */
export const NEON_MEME_FORME: ReadonlyArray<readonly [NeonToken, NeonToken]> = Object.freeze(
  [...new Set(Object.values(NEON_SIGNE_FAISCEAU).map((signe) => NEON_GRAMMAIRE[signe].trait))].map((trait) => Object.freeze([NEON_GRAMMAIRE.arret.trait, trait] as const)),
);

/**
 * Salle OMO : couleurs qui partagent une forme avec l'orange de l'extension. Le contour de l'enceinte (double trait) et celui des
 * territoires (hexagones) ; le cercle à glyphe de la marque « relance par l'extension » et celui des autres marques d'origine
 * (neon.css, .neon-origine). Contrôlées par le script comme NEON_MEME_FORME.
 */
export const NEON_MEME_FORME_SALLE: ReadonlyArray<readonly [NeonToken, NeonToken]> = Object.freeze([
  Object.freeze(["extension", "territoire"] as const),
  Object.freeze(["extension", "acteur"] as const),
]);

export const SEUIL_TRAIT = 3;
export const SEUIL_TEXTE = 4.5;
/** Écart CIE 1976 minimal entre deux couleurs de même forme (au-delà de 10, deux couleurs se distinguent sans les comparer). */
export const SEUIL_ECART = 15;

export type Vision = "normale" | "deuteranopie" | "protanopie";
export const VISIONS: readonly Vision[] = Object.freeze(["normale", "deuteranopie", "protanopie"]);

type Rgb = readonly [number, number, number];
type Matrix = readonly [Rgb, Rgb, Rgb];

/** Machado, Oliveira et Fernandes (2009), sévérité 1,0, en RVB linéaire. */
export const CVD_MATRICES: Readonly<Record<Exclude<Vision, "normale">, Matrix>> = Object.freeze({
  protanopie: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopie: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
});

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

/** Couleur « #RRGGBB » en composantes sRGB de 0 à 1 ; lève RangeError sinon (la couleur refusée n'est pas recopiée). */
export function parseHex(color: string): Rgb {
  if (typeof color !== "string" || !HEX_RE.test(color)) throw new RangeError("couleur refusée : #RRGGBB attendu");
  return [Number.parseInt(color.slice(1, 3), 16) / 255, Number.parseInt(color.slice(3, 5), 16) / 255, Number.parseInt(color.slice(5, 7), 16) / 255];
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Composantes RVB linéaires de la couleur telle qu'une personne de cette vision la perçoit. */
export function simulate(color: string, vision: Vision): Rgb {
  const [r, g, b] = parseHex(color);
  const linear: Rgb = [toLinear(r), toLinear(g), toLinear(b)];
  if (vision === "normale") return linear;
  const [m0, m1, m2] = CVD_MATRICES[vision];
  const apply = (row: Rgb) => clamp01(row[0] * linear[0] + row[1] * linear[1] + row[2] * linear[2]);
  return [apply(m0), apply(m1), apply(m2)];
}

/** Luminance relative WCAG 2.x d'une couleur en RVB linéaire. */
export function relativeLuminance(linear: Rgb): number {
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** Rapport de contraste WCAG 2.x (1 à 21) entre deux couleurs, pour une vision. */
export function contrastRatio(a: string, b: string, vision: Vision = "normale"): number {
  const la = relativeLuminance(simulate(a, vision));
  const lb = relativeLuminance(simulate(b, vision));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** CIE L*a*b* (blanc D65) d'une couleur en RVB linéaire. */
function lab(linear: Rgb): Rgb {
  const x = (0.4124 * linear[0] + 0.3576 * linear[1] + 0.1805 * linear[2]) / 0.95047;
  const y = relativeLuminance(linear);
  const z = (0.0193 * linear[0] + 0.1192 * linear[1] + 0.9505 * linear[2]) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** Écart de couleur CIE 1976 (ΔE*ab) entre deux couleurs, pour une vision. */
export function colorDistance(a: string, b: string, vision: Vision = "normale"): number {
  const p = lab(simulate(a, vision));
  const q = lab(simulate(b, vision));
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

export interface ColorProblem {
  theme: NeonTheme;
  vision: Vision;
  /** « contraste » : jeton contre un jeton de décor ; « ecart » : deux couleurs de même forme trop proches. */
  mesure: "contraste" | "ecart";
  jeton: NeonToken;
  contre: NeonToken;
  valeur: number;
  seuil: number;
}

/** Script couleurs JP-14 : manquements d'une palette, vide si elle passe. Une couleur mal écrite lève RangeError. */
export function paletteProblems(palette: NeonPalette, theme: NeonTheme): ColorProblem[] {
  const problems: ColorProblem[] = [];
  for (const vision of VISIONS) {
    const check = (jeton: NeonToken, seuil: number) => {
      for (const contre of NEON_DECOR) {
        const valeur = contrastRatio(palette[jeton], palette[contre], vision);
        if (valeur < seuil) problems.push({ theme, vision, mesure: "contraste", jeton, contre, valeur, seuil });
      }
    };
    for (const jeton of NEON_TRAITS) check(jeton, SEUIL_TRAIT);
    for (const jeton of NEON_TEXTES) check(jeton, SEUIL_TEXTE);
    for (const [jeton, contre] of [...NEON_MEME_FORME, ...NEON_MEME_FORME_SALLE]) {
      const valeur = colorDistance(palette[jeton], palette[contre], vision);
      if (valeur < SEUIL_ECART) problems.push({ theme, vision, mesure: "ecart", jeton, contre, valeur, seuil: SEUIL_ECART });
    }
  }
  return problems;
}

/** Script couleurs JP-14 sur les deux palettes livrées : vide si toutes deux passent. */
export function neonColorProblems(): ColorProblem[] {
  return (Object.keys(NEON_PALETTES) as NeonTheme[]).flatMap((theme) => paletteProblems(NEON_PALETTES[theme], theme));
}

/** Variables CSS d'une palette (`--neon-<jeton>`), pour le bloc de jetons de styles.css (L5c). */
export function neonCssVariables(theme: NeonTheme): Record<string, string> {
  const palette = NEON_PALETTES[theme];
  return Object.fromEntries((Object.keys(palette) as NeonToken[]).map((token) => [`--neon-${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, palette[token]]));
}
