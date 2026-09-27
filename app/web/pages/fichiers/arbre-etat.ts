// Propriétaire : NAV-3.
// État de l'arborescence de l'onglet « Fichiers » (fiche NAV §5, instruction 4) : module pur, sans React ni navigateur, testé sous
// Node (server/web-fichiers.test.ts). Chaque fonction rend un nouvel état, sans toucher l'ancien.
// - ouvrir : le dossier est déplié ; sa liste est demandée à la première ouverture seulement (une requête « dossier »), puis gardée
//   en cache jusqu'à « Actualiser » (vider) ; replier ne vide pas le cache ;
// - recevoir : une liste plus récente remplace l'ancienne ;
// - lignesVisibles : l'arbre à montrer, avec le filtre des fichiers cachés et générés (G5 : choix d'affichage, jamais une barrière),
//   sauf pour les éléments révélés par une adresse explicite (reveler), montrés même cachés en mode Simple ;
// - ancetres : les dossiers à déplier pour révéler une adresse profonde.
// Chemins relatifs au projet, « / » comme seul séparateur, "" pour le projet lui-même (fiche §2.5).
import type { DossierReponse, EntreeVue } from "../../../server/shared/fichiers-types.ts";

export interface ArbreEtat {
  /** Dossiers dépliés (le projet lui-même : ""). */
  readonly ouverts: ReadonlySet<string>;
  /** Listes reçues, gardées jusqu'à « Actualiser ». */
  readonly listes: ReadonlyMap<string, DossierReponse>;
  /** Listes demandées, pas encore reçues. */
  readonly chargements: ReadonlySet<string>;
  /** Refus ou échec de la dernière demande, par dossier (code des routes, ou « erreur »). */
  readonly erreurs: ReadonlyMap<string, string>;
  /** Éléments révélés par une adresse explicite, et leurs dossiers : montrés même cachés ou générés. */
  readonly reveles: ReadonlySet<string>;
}

export interface LigneVisible {
  entree: EntreeVue;
  /** Chemin de l'élément, relatif au projet. */
  chemin: string;
  /** Dossier déplié : son contenu ; sinon null. */
  contenu: DossierVisible | null;
}

export interface DossierVisible {
  chemin: string;
  chargement: boolean;
  erreur: string | null;
  /** Liste reçue (même vide). */
  charge: boolean;
  lignes: LigneVisible[];
  /** Éléments protégés, dont seul le nombre est connu. */
  masques: number;
  tronque: boolean;
  /** Nombre d'entrées reçues (avant le filtre d'affichage). */
  recues: number;
}

/** Chemin d'un élément dans un dossier. */
export function cheminDe(dossier: string, nom: string): string {
  return dossier === "" ? nom : `${dossier}/${nom}`;
}

/** État vide : rien de déplié, aucun cache (« Actualiser », changement de projet). */
export function vider(): ArbreEtat {
  return { ouverts: new Set(), listes: new Map(), chargements: new Set(), erreurs: new Map(), reveles: new Set() };
}

/** Déplie un dossier ; sa liste est demandée s'il n'y en a aucune en cache ni en cours (un refus précédent est oublié). */
export function ouvrir(etat: ArbreEtat, chemin: string): ArbreEtat {
  const ouverts = new Set(etat.ouverts).add(chemin);
  if (etat.listes.has(chemin) || etat.chargements.has(chemin)) return { ...etat, ouverts };
  const erreurs = new Map(etat.erreurs);
  erreurs.delete(chemin);
  return { ...etat, ouverts, erreurs, chargements: new Set(etat.chargements).add(chemin) };
}

/** Replie un dossier ; sa liste reste en cache. */
export function fermer(etat: ArbreEtat, chemin: string): ArbreEtat {
  const ouverts = new Set(etat.ouverts);
  ouverts.delete(chemin);
  return { ...etat, ouverts };
}

/** Liste reçue pour `chemin` : elle remplace toute liste plus ancienne. */
export function recevoir(etat: ArbreEtat, chemin: string, reponse: DossierReponse): ArbreEtat {
  const chargements = new Set(etat.chargements);
  chargements.delete(chemin);
  const erreurs = new Map(etat.erreurs);
  erreurs.delete(chemin);
  return { ...etat, listes: new Map(etat.listes).set(chemin, reponse), chargements, erreurs };
}

/** Demande refusée ou en échec pour `chemin` (code des routes, ou « erreur »). */
export function echouer(etat: ArbreEtat, chemin: string, code: string): ArbreEtat {
  const chargements = new Set(etat.chargements);
  chargements.delete(chemin);
  return { ...etat, chargements, erreurs: new Map(etat.erreurs).set(chemin, code) };
}

/** Dossiers à déplier pour montrer l'élément `segments` : le projet, puis chaque dossier parent. [] pour le projet lui-même. */
export function ancetres(segments: readonly string[]): string[] {
  if (segments.length === 0) return [];
  const dossiers = [""];
  for (let i = 1; i < segments.length; i++) dossiers.push(segments.slice(0, i).join("/"));
  return dossiers;
}

/**
 * Révèle l'élément `segments` (adresse explicite, résultat de recherche, fil d'Ariane) : ses dossiers parents sont dépliés, et
 * l'élément comme ses parents restent visibles même cachés ou générés. `deplier` : l'élément est un dossier, déplié aussi.
 */
export function reveler(etat: ArbreEtat, segments: readonly string[], deplier = false): ArbreEtat {
  let suivant = etat;
  for (const dossier of ancetres(segments)) suivant = ouvrir(suivant, dossier);
  const cible = segments.join("/");
  if (deplier) suivant = ouvrir(suivant, cible);
  const reveles = new Set(suivant.reveles);
  for (let i = 1; i <= segments.length; i++) reveles.add(segments.slice(0, i).join("/"));
  return { ...suivant, reveles };
}

/** Entrée montrée : tout est montré avec la case cochée ; sinon ni fichier caché ni dossier généré, sauf révélé. */
function montree(etat: ArbreEtat, entree: EntreeVue, chemin: string, montrerCaches: boolean): boolean {
  return montrerCaches || !(entree.cache || entree.genere) || etat.reveles.has(chemin);
}

function dossierVisible(etat: ArbreEtat, chemin: string, montrerCaches: boolean, profondeur: number): DossierVisible {
  const liste = etat.listes.get(chemin);
  const lignes: LigneVisible[] = [];
  for (const entree of liste?.entrees ?? []) {
    const cheminEntree = cheminDe(chemin, entree.nom);
    if (!montree(etat, entree, cheminEntree, montrerCaches)) continue;
    // Profondeur bornée comme un chemin (64 segments) : un état fabriqué ne fait jamais boucler l'affichage.
    const deplie = entree.type === "dossier" && etat.ouverts.has(cheminEntree) && profondeur < 64;
    lignes.push({ entree, chemin: cheminEntree, contenu: deplie ? dossierVisible(etat, cheminEntree, montrerCaches, profondeur + 1) : null });
  }
  return {
    chemin,
    chargement: etat.chargements.has(chemin),
    erreur: etat.erreurs.get(chemin) ?? null,
    charge: liste !== undefined,
    lignes,
    masques: liste?.masques ?? 0,
    tronque: liste?.tronque ?? false,
    recues: liste?.entrees.length ?? 0,
  };
}

/** Arbre à montrer depuis le projet lui-même (""), dossiers dépliés compris. */
export function lignesVisibles(etat: ArbreEtat, options: { montrerCaches: boolean }): DossierVisible {
  return dossierVisible(etat, "", options.montrerCaches, 0);
}
