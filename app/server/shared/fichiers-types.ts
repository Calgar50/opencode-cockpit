// Contrat de l'onglet « Fichiers » (1.1, décisions A19 point 2, A21 ; fiche NAV §2.2), partagé par le serveur (routes
// POST /api/fichiers/*, lecteur disque) et le web. Types seuls (règle *-types.ts de core.test.ts) : les règles pures sont dans
// fichiers-regles.ts, les textes dans fichiers-texts.ts. Lecture seule : aucune route n'écrit, aucune n'appelle opencode.

/** Codes d'erreur des routes « fichiers » (fiche §2.3) ; le web choisit sa phrase d'après le code (phraseErreur). */
export type FichiersCode =
  | "invalide"
  | "trop-long"
  | "fichiers-coupes"
  | "protege"
  | "lien"
  | "plusieurs-noms"
  | "projet-inconnu"
  | "introuvable"
  | "pas-un-dossier"
  | "pas-un-fichier"
  | "a-change"
  | "illisible"
  | "occupe";

/** Les quatre routes, toutes en POST ; leurs adresses sont écrites une seule fois dans FICHIERS_ROUTES (fichiers-regles.ts). */
export type FichiersRoute = "dossier" | "contenu" | "recents" | "recherche";

/**
 * Type d'une entrée de dossier, lu par lstat (jamais sur le Dirent seul) :
 * - « lien » : lien symbolique, montré sans sa cible, jamais suivi ;
 * - « douteux » : nom qui viole segmentSur (nom court 8.3, point ou espace final, nom réservé de Windows…), montré, jamais ouvert ;
 * - « autre » : tube, socket ou périphérique, jamais ouvert.
 */
export type EntreeType = "dossier" | "fichier" | "lien" | "douteux" | "autre";

export interface EntreeVue {
  /** Nom exact sur le disque (sert à construire le chemin). */
  nom: string;
  /** rendreVisible(nom) : caractères invisibles et de contrôle montrés « ⟦U+XXXX⟧ » ; rendu par le web dans un élément bdi. */
  nomVisible: string;
  type: EntreeType;
  /** Octets, fichiers seulement. */
  taille: number | null;
  /** mtime en millisecondes. */
  modifieA: number | null;
  /** Nom qui commence par « . ». */
  cache: boolean;
  /** Nom dans GENERES (fiche §2.4). */
  genere: boolean;
}

export interface DossierReponse {
  projet: string;
  chemin: string;
  entrees: EntreeVue[];
  /** Entrées protégées (estProtege) : ni nom, ni lstat, seulement leur nombre. */
  masques: number;
  /** Plus de ENTREES_MAX entrées : seules les premières sont rendues. */
  tronque: boolean;
}

export type Encodage = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "windows-1252";

export interface ContenuReponse {
  projet: string;
  chemin: string;
  etat: "texte" | "vide" | "binaire";
  taille: number;
  modifieA: number;
  encodage: Encodage | null;
  /** null pour « binaire » : ni octets, ni base64. */
  texte: string | null;
  lignes: number;
  tronque: boolean;
  lignesCoupees: number;
  secretsMasques: boolean;
  invisibles: number;
}

export interface RecentsReponse {
  projet: string;
  fichiers: Array<{ chemin: string; taille: number; modifieA: number }>;
  parcourus: number;
  incomplet: boolean;
}

export interface RechercheReponse {
  projet: string;
  texte: string;
  resultats: Array<{ chemin: string; type: "dossier" | "fichier" }>;
  parcourus: number;
  incomplet: boolean;
}

export interface FichiersErreur {
  error: FichiersCode;
  message: string;
}
