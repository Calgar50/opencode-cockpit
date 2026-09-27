// Propriétaire : L31b.
// Clavier de la liste en grille du zoom 1 (spécification §5.5 l.917 « aucun raccourci à une touche hors composant focalisé ;
// flèches selon APG », §5.8 l.1009 « la vérité est la liste » ; plan d'exécution it3, fiche L31b). Module PUR : aucun React,
// aucun DOM, aucun texte — la page traduit l'action en déplacement du focus ou en ouverture du zoom 2.
// - La grille est une suite de lignes de longueurs libres (un projet par ligne, une conversation par cellule) ; la cellule
//   courante est un index de lecture, lignes mises bout à bout. Une ligne vide (projet sans conversation récente) est sautée.
// - AUCUNE touche n'est prise quand l'événement ne vient pas d'une cellule de la grille (`dansLaGrille` faux) : ni Échap, ni les
//   flèches, ni Entrée. Un bouton posé dans une cellule (par exemple [Revoir cette demande]) garde donc ses propres touches.
// - Au bord, la flèche est prise mais ne déplace rien (APG : pas de bouclage) : le focus ne saute jamais d'une ligne à l'autre.
// - Alt+flèche appartient au navigateur (page précédente) : jamais prise.

/** Ce que la grille fait d'une touche : déplacer la cellule courante, ou ouvrir la conversation de la cellule courante. */
export type ActionGrille = { type: "deplacer"; index: number } | { type: "ouvrir"; index: number };

/** Touche reçue, réduite à ce que la grille lit (KeyboardEvent du navigateur ou objet d'essai). */
export interface ToucheGrille {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export interface EtatGrille {
  /** Nombre de cellules de chaque ligne, dans l'ordre d'affichage. */
  lignes: readonly number[];
  /** Cellule courante (index de lecture) ; hors bornes : ramenée dans la grille. */
  index: number;
  /** L'événement vient d'une cellule de cette grille (§5.5 l.917) : sinon aucune touche n'est prise. */
  dansLaGrille: boolean;
}

/** Nombre total de cellules. */
export function totalCellules(lignes: readonly number[]): number {
  return lignes.reduce((total, n) => total + Math.max(0, Math.trunc(n)), 0);
}

/** Ligne et colonne d'un index de lecture ; null si la grille est vide ou l'index hors bornes. */
export function positionDe(lignes: readonly number[], index: number): { ligne: number; colonne: number } | null {
  if (!Number.isInteger(index) || index < 0) return null;
  let reste = index;
  for (let ligne = 0; ligne < lignes.length; ligne += 1) {
    const taille = Math.max(0, Math.trunc(lignes[ligne] ?? 0));
    if (reste < taille) return { ligne, colonne: reste };
    reste -= taille;
  }
  return null;
}

/** Index de lecture d'une ligne et d'une colonne ; la colonne est ramenée dans la ligne. */
export function indexDe(lignes: readonly number[], ligne: number, colonne: number): number {
  let debut = 0;
  for (let i = 0; i < ligne; i += 1) debut += Math.max(0, Math.trunc(lignes[i] ?? 0));
  const taille = Math.max(0, Math.trunc(lignes[ligne] ?? 0));
  return debut + Math.min(Math.max(colonne, 0), Math.max(taille - 1, 0));
}

/** Ligne non vide la plus proche dans le sens donné, à partir de `depart` exclu ; null s'il n'y en a pas (bord de la grille). */
function ligneVoisine(lignes: readonly number[], depart: number, pas: 1 | -1): number | null {
  for (let ligne = depart + pas; ligne >= 0 && ligne < lignes.length; ligne += pas) {
    if (Math.max(0, Math.trunc(lignes[ligne] ?? 0)) > 0) return ligne;
  }
  return null;
}

/**
 * Touche prise par la grille, ou null quand la grille n'en fait rien (la page laisse alors la touche au navigateur et aux
 * commandes de la cellule). Début et Fin vont au bord de la ligne ; avec Ctrl (ou Cmd), au bord de la grille entière.
 */
export function toucheGrille(touche: ToucheGrille, etat: EtatGrille): ActionGrille | null {
  if (!etat.dansLaGrille || touche.altKey === true) return null;
  const total = totalCellules(etat.lignes);
  if (total === 0) return null;
  const index = Math.min(Math.max(Number.isInteger(etat.index) ? etat.index : 0, 0), total - 1);
  const position = positionDe(etat.lignes, index);
  if (position === null) return null;
  const { ligne, colonne } = position;
  const entiere = touche.ctrlKey === true || touche.metaKey === true;
  const deplacer = (vers: number): ActionGrille => ({ type: "deplacer", index: vers });

  switch (touche.key) {
    case "ArrowRight":
      return deplacer(indexDe(etat.lignes, ligne, colonne + 1));
    case "ArrowLeft":
      return deplacer(indexDe(etat.lignes, ligne, colonne - 1));
    case "ArrowDown": {
      const suivante = ligneVoisine(etat.lignes, ligne, 1);
      return deplacer(suivante === null ? index : indexDe(etat.lignes, suivante, colonne));
    }
    case "ArrowUp": {
      const precedente = ligneVoisine(etat.lignes, ligne, -1);
      return deplacer(precedente === null ? index : indexDe(etat.lignes, precedente, colonne));
    }
    case "Home":
      return deplacer(entiere ? 0 : indexDe(etat.lignes, ligne, 0));
    case "End":
      return deplacer(entiere ? total - 1 : indexDe(etat.lignes, ligne, Number.MAX_SAFE_INTEGER));
    case "Enter":
      return { type: "ouvrir", index };
    default:
      // Échap, espace, lettres, Tab : jamais prises ici (Échap appartient à la boîte ou au composant qui a le focus, l'espace au
      // bouton de la cellule, qui ouvre la même conversation).
      return null;
  }
}
