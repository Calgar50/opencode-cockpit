// Textures générées de la salle de contrôle 3D (itération 3, L29b ; spécification §5.8 l.995-996, §5.7.1 ; plan it3 D-3d-17,
// D-3d-05 ; mesure MX-3D M3D-2). Chaque texture est une `DataTexture` : ses octets sont CALCULÉS ici, jamais chargés d'une image
// ni peints sur un canevas. C'est ce qui garde la CSP inchangée (M3D-2 : 0 violation pendant 5 s de rendu, DataTexture comme
// CanvasTexture ; la forme retenue est la DataTexture, sans `blob:` ni `data:`).
// - halo : disque radial doux, posé sur un `Sprite` additif (un seul exemplaire par graphe) ;
// - faisceaux : une période du motif qui code la forme du faisceau (chevrons, losanges, pointillé, flèche) ; la répétition le long
//   du tube passe par `repeat`, le défilement par `offset`, jamais par une nouvelle texture ;
// - marques : la forme propre de chaque marque (hexagone hachuré de l'attente, bouclier, croix, carré d'arrêt, anneau d'origine,
//   impulsion), « la forme d'abord » : la couleur du jeton ne fait que la doubler.
// Les octets portent le même niveau en rouge, vert, bleu et alpha : la texture est un MASQUE blanc que la couleur du matériau
// teinte. Tailles en puissance de deux, sans mipmaps (`LinearFilter`).
// Seuls les fichiers de ce dossier importent "three", par imports NOMMÉS statiques (D-3d-05 ; M3D-3 : `import("three")` n'est pas
// élagué). Aucun texte affiché.
import { ClampToEdgeWrapping, DataTexture, LinearFilter, RepeatWrapping, RGBAFormat, SRGBColorSpace } from "three";
import type { Plan3dBeam, Plan3dMark } from "../../../../server/shared/salle3d-types.ts";

/** Forme d'un faisceau, telle que le plan la donne. */
export type FormeFaisceau = Plan3dBeam["forme"];
/** Genre d'une marque, tel que le plan le donne. */
export type GenreMarque = Plan3dMark["kind"];

/** Côté de la texture du halo et d'une marque (puissance de deux). */
export const TAILLE_MARQUE = 64;
/** Une période du motif d'un faisceau : long dans le sens du tube, court en travers. */
export const LARGEUR_FAISCEAU = 64;
export const HAUTEUR_FAISCEAU = 16;

/**
 * Masque d'une texture : niveau de 0 à 1 au point (u, v), chacun dans [0, 1[. `flipY` d'une `DataTexture` vaut faux : la première
 * ligne des octets est v = 0. Les formes tracées ici sont symétriques en v, ce sens n'a donc aucun effet visible.
 */
export type Masque = (u: number, v: number) => number;

// --- Outils de tracé (purs, sans three) -------------------------------------------------------------------------------------------

const borner = (v: number) => Math.min(1, Math.max(0, v));

/** Transition douce de 0 (en `bas`) à 1 (en `haut`), comme `smoothstep` en GLSL. */
function adoucir(bas: number, haut: number, v: number): number {
  if (haut <= bas) return v < bas ? 0 : 1;
  const t = borner((v - bas) / (haut - bas));
  return t * t * (3 - 2 * t);
}

/** Bande pleine : 1 tant que `distance` reste sous `demi`, 0 au-delà de `demi + flou`. */
const bande = (distance: number, demi: number, flou: number) => 1 - adoucir(demi, demi + flou, distance);

/** Coordonnée centrée : u ou v de [0, 1[ vers [-1, 1[. */
const centre = (t: number) => t * 2 - 1;

/** Distance d'un hexagone régulier pointe en haut : la valeur vaut le rayon du plus petit hexagone qui contient le point. */
const distanceHexagone = (x: number, y: number) => Math.max(Math.abs(x) * 0.8660254 + Math.abs(y) * 0.5, Math.abs(y));

// --- Masques ------------------------------------------------------------------------------------------------------------------------

/** Halo : disque doux, cœur plus clair, éteint au bord (le carré de la texture reste transparent dans ses coins). */
export const masqueHalo: Masque = (u, v) => {
  const r = Math.hypot(centre(u), centre(v));
  if (r >= 1) return 0;
  const fondu = (1 - r) * (1 - r);
  return borner(fondu * 0.75 + bande(r, 0.12, 0.28) * 0.35);
};

/** Une période du motif de chaque forme de faisceau, dans le sens du tube (u) et en travers (v). */
export const MASQUES_FAISCEAU: Readonly<Record<FormeFaisceau, Masque>> = {
  // Chevron « > » : la pointe est au milieu du tube, les branches rejoignent les bords.
  chevrons: (u, v) => {
    const t = Math.abs(centre(v));
    const pointe = 0.15 + 0.6 * (1 - t);
    return bande(Math.abs(u - pointe), 0.09, 0.07) * bande(t, 0.82, 0.18);
  },
  // Losange plein : la somme des écarts au centre reste sous un seuil.
  losanges: (u, v) => bande(Math.abs(centre(u)) + Math.abs(centre(v)), 0.72, 0.26),
  // Pointillé : un tiret arrondi par période.
  pointille: (u, v) => bande(Math.abs(centre(u)), 0.4, 0.16) * bande(Math.abs(centre(v)), 0.42, 0.22),
  // Flèche : un fût suivi d'une tête qui se resserre jusqu'au bout de la période.
  fleche: (u, v) => {
    const t = Math.abs(centre(v));
    const fut = u < 0.56 ? bande(t, 0.26, 0.1) : 0;
    const tete = u >= 0.5 ? bande(t, borner((1 - u) / 0.5) * 0.92, 0.08) : 0;
    return Math.max(fut, tete);
  },
};

/** Forme propre de chaque marque (§5.7.1, « la forme d'abord ») : deux marques n'ont jamais le même tracé. */
export const MASQUES_MARQUE: Readonly<Record<GenreMarque, Masque>> = {
  // Attente d'accord : hexagone hachuré.
  attente: (u, v) => {
    const x = centre(u);
    const y = centre(v);
    const d = distanceHexagone(x, y);
    const contour = bande(Math.abs(d - 0.74), 0.09, 0.05);
    const raie = Math.abs((((x + y) * 3.5 + 100) % 1) - 0.5);
    const hachures = d < 0.7 ? bande(raie, 0.16, 0.12) : 0;
    return Math.max(contour, hachures * 0.75);
  },
  // Décision automatique : bouclier plein, épaules en haut, pointe en bas.
  auto: (u, v) => {
    const x = Math.abs(centre(u));
    const y = centre(v);
    const largeur = y > -0.1 ? 0.62 : 0.62 * borner((y + 0.86) / 0.76);
    return bande(x, largeur, 0.08) * bande(y, 0.68, 0.08);
  },
  // Refus : croix en X.
  refus: (u, v) => {
    const x = centre(u);
    const y = centre(v);
    const branches = Math.max(bande(Math.abs(x - y), 0.17, 0.07), bande(Math.abs(x + y), 0.17, 0.07));
    return branches * bande(Math.max(Math.abs(x), Math.abs(y)), 0.68, 0.12);
  },
  // Origine d'un message : anneau fin.
  origine: (u, v) => bande(Math.abs(Math.hypot(centre(u), centre(v)) - 0.62), 0.11, 0.06),
  // Appel d'IA : impulsion, disque plein cerné d'un anneau.
  impulsion: (u, v) => {
    const r = Math.hypot(centre(u), centre(v));
    return Math.max(bande(r, 0.3, 0.09), bande(Math.abs(r - 0.76), 0.07, 0.05));
  },
  // Arrêt : carré plein.
  arret: (u, v) => bande(Math.max(Math.abs(centre(u)), Math.abs(centre(v))), 0.58, 0.07),
};

// --- Fabrique de textures ------------------------------------------------------------------------------------------------------------

/** Octets RGBA d'un masque : même niveau sur les quatre voies (masque blanc teinté par la couleur du matériau). */
export function octetsDuMasque(largeur: number, hauteur: number, masque: Masque): Uint8Array {
  const octets = new Uint8Array(largeur * hauteur * 4);
  for (let y = 0; y < hauteur; y++) {
    for (let x = 0; x < largeur; x++) {
      const niveau = Math.round(borner(masque((x + 0.5) / largeur, (y + 0.5) / hauteur)) * 255);
      const i = (y * largeur + x) * 4;
      octets[i] = niveau;
      octets[i + 1] = niveau;
      octets[i + 2] = niveau;
      octets[i + 3] = niveau;
    }
  }
  return octets;
}

/** `DataTexture` d'un masque ; `repeteEnU` ouvre la répétition et le défilement le long du tube d'un faisceau. */
function creerTexture(largeur: number, hauteur: number, masque: Masque, repeteEnU: boolean): DataTexture {
  const texture = new DataTexture(octetsDuMasque(largeur, hauteur, masque), largeur, hauteur, RGBAFormat);
  texture.wrapS = repeteEnU ? RepeatWrapping : ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Halo radial d'un nœud (`Sprite` additif). Le graphe n'en crée qu'un et le partage (M3D-5 : libéré une seule fois). */
export const textureHalo = (): DataTexture => creerTexture(TAILLE_MARQUE, TAILLE_MARQUE, masqueHalo, false);

/** Motif d'un faisceau : répétable en u, donc défilable par `offset` dans `animer` (D-3d-17). */
export const textureFaisceau = (forme: FormeFaisceau): DataTexture => creerTexture(LARGEUR_FAISCEAU, HAUTEUR_FAISCEAU, MASQUES_FAISCEAU[forme], true);

/** Forme fixe d'une marque. */
export const textureMarque = (genre: GenreMarque): DataTexture => creerTexture(TAILLE_MARQUE, TAILLE_MARQUE, MASQUES_MARQUE[genre], false);
