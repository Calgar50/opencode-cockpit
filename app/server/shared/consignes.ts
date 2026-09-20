// Propriétaire : L28d.
// Bornes de la copie locale d'une consigne transmise à un sous-assistant (U2, D-3d-30 ; plan d'exécution it3 §6 « L28d »).
// Module PUR de server/shared : aucune horloge, aucun accès à la base, AUCUNE chaîne affichable (contrôle « sans texte » de
// textes-3d.test.ts, D-3d-21). Le masquage n'est pas fait ici : l'appelant passe redactSecrets, ce qui garde ce module sans
// dépendance et testable seul.
// Ordre imposé (D-3d-30) : lecture bornée, PUIS masquage, PUIS coupe. Masquer avant de couper évite qu'un secret reconnu se
// retrouve gardé en morceaux, et couper après le masquage compte les caractères réellement affichés.

/** Bornes de la copie gardée : lecture, texte gardé, nombre de copies par conversation. */
export const CONSIGNES = {
  /** Unités UTF-16 lues au plus dans le texte d'origine (borne du travail de masquage). */
  lectureMax: 64_000,
  /** Points de code gardés au plus après masquage. */
  maxCaracteres: 8_000,
  /** Copies gardées au plus par conversation ; au-delà, rien n'est écrit. */
  parRacine: 500,
} as const;

/** Copie bornée : `texte` masqué puis coupé, `longueur` = points de code du texte d'origine, `tronque` = une coupe a eu lieu. */
export interface ConsigneBornee {
  texte: string;
  longueur: number;
  tronque: boolean;
}

const HAUT_MIN = 0xd800;
const HAUT_MAX = 0xdbff;
const BAS_MIN = 0xdc00;
const BAS_MAX = 0xdfff;

const estHaut = (code: number): boolean => code >= HAUT_MIN && code <= HAUT_MAX;
const estBas = (code: number): boolean => code >= BAS_MIN && code <= BAS_MAX;

/** Vrai si l'unité d'indice `i` ouvre une paire de substitution complète : les deux unités sont un seul point de code. */
const paireEn = (texte: string, i: number): boolean => estHaut(texte.charCodeAt(i)) && i + 1 < texte.length && estBas(texte.charCodeAt(i + 1));

/** Points de code d'une chaîne, sans en construire de copie (un emoji compte pour 1, pas 2). */
export function pointsDeCode(texte: string): number {
  let n = 0;
  for (let i = 0; i < texte.length; i += paireEn(texte, i) ? 2 : 1) n++;
  return n;
}

/** Préfixe d'au plus `max` points de code, jamais coupé au milieu d'une paire de substitution ; `coupe` : du texte est resté. */
function prefixe(texte: string, max: number): { texte: string; coupe: boolean } {
  let i = 0;
  for (let n = 0; i < texte.length && n < max; n++) i += paireEn(texte, i) ? 2 : 1;
  return i >= texte.length ? { texte, coupe: false } : { texte: texte.slice(0, i), coupe: true };
}

/**
 * Copie gardée d'une consigne : les `lectureMax` premières unités du texte d'origine sont masquées par `masquer` (redactSecrets,
 * passé par l'appelant), puis coupées à `maxCaracteres` points de code. Une paire de substitution n'est jamais séparée, ni à la
 * lecture ni à la coupe. `longueur` compte les points de code du texte d'origine entier : la mention de troncature dit toujours
 * combien de caractères ont été écartés.
 */
export function bornerConsigne(brut: string, masquer: (texte: string) => string): ConsigneBornee {
  const longueur = pointsDeCode(brut);
  let lu = brut;
  let tronque = false;
  if (brut.length > CONSIGNES.lectureMax) {
    lu = brut.slice(0, CONSIGNES.lectureMax);
    // Dernière unité laissée seule par la coupe de lecture : retirée, sinon elle survivrait au masquage en demi-caractère.
    if (estHaut(lu.charCodeAt(lu.length - 1))) lu = lu.slice(0, -1);
    tronque = true;
  }
  const { texte, coupe } = prefixe(masquer(lu), CONSIGNES.maxCaracteres);
  return { texte, longueur, tronque: tronque || coupe };
}
