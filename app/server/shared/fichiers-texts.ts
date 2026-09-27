// Textes de l'onglet « Fichiers » (1.1, décisions A19 point 2, A21 ; fiche NAV §8), contrôlés par textes.test.ts : aucun mot
// interdit en Simple dans « simple » ni « partout », aucun interdit ni banni partout, gabarits « {nom} ». Honnêteté (P3) :
// - « rien n'est modifié et rien n'est envoyé à une IA » : routes en lecture seule sur un montage :ro, sans client opencode
//   ni ledger (NAV-2) ;
// - « éléments protégés ne sont pas montrés » : estProtege (fichiers-regles.ts), décidé avant tout accès au disque ;
// - « remplacés par **** » : blocs de clé privée ligne par ligne puis redactSecrets (preparerTexte), masquage « au mieux ».
import type { FichiersCode, FichiersRoute } from "./fichiers-types.ts";

export const TEXTES = {
  partout: {
    rail: "Fichiers",
    titre: "Fichiers des projets",
    sousTitre: "Lecture seule : ici, rien n'est modifié et rien n'est envoyé à une IA.",
    badge: "Lecture seule",
    projet: "Projet",
    racine: "Tout le workspace",
    actualiser: "Actualiser",
    recents: "Modifiés récemment",
    recentsVides: "Aucun fichier modifié récemment dans ce projet.",
    voirPlus: "Voir plus",
    chercher: "Chercher un nom de fichier",
    boutonChercher: "Chercher",
    resultats: "Résultats de la recherche",
    rechercheVide: "Aucun fichier ne correspond à « {texte} ».",
    afficherCaches: "Afficher les fichiers cachés et générés",
    arbre: "Fichiers de {projet}",
    filAriane: "Emplacement dans le projet",
    chargement: "Chargement",
    travailVide: "Le dossier de travail est vide. Les fichiers créés par l'IA apparaîtront ici.",
    dossierVide: "Ce dossier est vide.",
    aucunChoix: "Choisissez un fichier pour le lire.",
    masquesUn: "1 élément protégé n'est pas montré : clés, mots de passe, historique git.",
    masquesPlusieurs: "{n} éléments protégés ne sont pas montrés : clés, mots de passe, historique git.",
    tronqueListe: "Seuls les {n} premiers éléments de ce dossier sont montrés.",
    recherchePartielle: "Recherche partielle : arrêtée après {n} éléments parcourus.",
    recentsPartiels: "Liste partielle : arrêtée après {n} éléments parcourus.",
    protegeFichier: "Ce fichier est protégé : il peut contenir des clés ou des mots de passe. Il n'est pas affiché.",
    protegeDossier: "Ce dossier est protégé : il peut contenir des clés ou des mots de passe. Il n'est pas affiché.",
    lienRefuse: "Par sécurité, ce lien n'est pas suivi.",
    plusieursNoms: "Ce fichier porte plusieurs noms sur le disque : par sécurité, il n'est pas affiché.",
    pasUnFichier: "Cet élément n'est pas un fichier ordinaire : il n'est pas ouvert.",
    pasUnDossier: "Cet élément n'est pas un dossier.",
    binaire: "Ce fichier n'est pas du texte (image, archive, programme…) : il n'est pas affiché.",
    vide: "Ce fichier est vide.",
    tropLong: "Ce fichier est long ({taille}) : seul le début est affiché.",
    finTronquee: "Fin de l'affichage : la suite du fichier n'est pas montrée ici.",
    ligneCoupee: "1 ligne trop longue est coupée.",
    lignesCoupees: "{n} lignes trop longues sont coupées.",
    secretsMasques: "Des passages qui ressemblent à des mots de passe ou à des clés sont remplacés par ****. Le fichier, lui, n'est pas modifié.",
    invisibleUn: "Ce fichier contient 1 caractère invisible, montré ainsi : ⟦U+202E⟧. Il peut faire lire autre chose que ce que l'ordinateur exécute.",
    invisiblesPlusieurs: "Ce fichier contient {n} caractères invisibles, montrés ainsi : ⟦U+202E⟧. Ils peuvent faire lire autre chose que ce que l'ordinateur exécute.",
    ancienFormat: "Fichier enregistré dans un ancien format Windows : quelques caractères peuvent s'afficher mal.",
    aChange: "Ce fichier a changé pendant la lecture.",
    introuvable: "Ce fichier ou ce dossier n'existe plus, ou son nom n'est pas pris en charge ici.",
    projetInconnu: "Ce projet n'existe plus dans le dossier de travail.",
    invalide: "Cette adresse de fichier n'est pas prise en charge.",
    tropLongRequete: "Cette demande est trop longue.",
    illisible: "Ce fichier ne peut pas être lu (droits ou disque).",
    occupe: "Une autre lecture est en cours. Réessayez dans un instant.",
    coupe: "La lecture des fichiers est coupée sur ce poste.",
    erreur: "Les fichiers ne peuvent pas être lus pour le moment. Réessayez dans un instant.",
    relire: "Relire",
    reessayer: "Réessayer",
    emplacement: "Sur votre poste : {chemin}",
    copierEmplacement: "Copier l'emplacement",
    emplacementCopie: "Emplacement copié.",
    copieImpossible: "La copie n'a pas pu se faire : sélectionnez l'emplacement affiché.",
    retourALaLigne: "Retour à la ligne",
    retourFichiers: "Retour aux fichiers",
    contenuDe: "Contenu de {nom}, {n} lignes",
    ouvrirDansFichiers: "Ouvrir dans Fichiers",
    annonceDossier: "Dossier ouvert : {nom}, {n} éléments",
    annonceFichier: "{nom} ouvert, {n} lignes",
    annonceResultats: "{n} résultats",
    // Singuliers (train V5, demande de NAV-3) : 0 et 1 s'accordent au singulier ; choisis par remplirAccorde.
    contenuDeUn: "Contenu de {nom}, {n} ligne",
    annonceDossierUn: "Dossier ouvert : {nom}, {n} élément",
    annonceFichierUn: "{nom} ouvert, {n} ligne",
    annonceResultatsUn: "{n} résultat",
  },
  simple: {
    lien: "raccourci, non ouvert",
    lienMessage: "C'est un raccourci vers un autre endroit : par sécurité, il n'est pas ouvert.",
    douteux: "nom ambigu, non ouvert",
    douteuxMessage: "Ce nom peut désigner un autre fichier sur Windows : par sécurité, il n'est pas ouvert.",
    autre: "élément spécial, non ouvert",
  },
  avance: {
    lien: "lien symbolique, non suivi",
    lienMessage: "Lien symbolique : il n'est jamais suivi, même vers ce projet.",
    douteux: "nom ambigu (nom court, point final, flux, nom réservé), non ouvert",
    douteuxMessage: "Nom ambigu sur un volume Windows (nom court, point ou espace final, flux, nom réservé) : il n'est pas ouvert.",
    autre: "tube, socket ou périphérique, non ouvert",
    details: "Encodage : {encodage} · {octets} octets · modifié le {date}",
    pourquoi: "Pourquoi ?",
    regles:
      "Sont protégés : l'historique git (.git), les fichiers d'environnement (.env…), les clés et certificats (.pem, .pfx, .key, id_rsa…), les fichiers d'identifiants (.npmrc, .netrc, auth.json…), les historiques de commandes, et les fichiers de données ou dossiers dont le nom contient credential, secret, passw ou token. Un script garde son nom : son contenu est masqué au mieux.",
    parcourus: "{n} éléments parcourus",
    cheminRelatif: "Chemin dans le projet : {chemin}",
  },
} as const;

/** Remplit un gabarit « {nom} » ; une clé absente de `valeurs` laisse son gabarit tel quel. */
export function remplir(gabarit: string, valeurs: Readonly<Record<string, string | number>>): string {
  return gabarit.replace(/\{(\w+)\}/g, (tout: string, cle: string) => (Object.hasOwn(valeurs, cle) ? String(valeurs[cle]) : tout));
}

/**
 * Gabarit accordé au nombre `n` : `singulier` pour 0 et 1 (usage français : « 0 élément », « 1 ligne »), `pluriel` au-delà.
 * Sert aux annonces et au nom du contenu, dont le nombre vient d'une réponse.
 */
export function remplirAccorde(singulier: string, pluriel: string, valeurs: Readonly<Record<string, string | number>> & { readonly n: number }): string {
  return remplir(Math.abs(valeurs.n) < 2 ? singulier : pluriel, valeurs);
}

/**
 * Phrase d'une erreur des routes (forme « partout » renvoyée par le serveur) : « protege » dit « fichier » sur la route contenu
 * et « dossier » ailleurs ; « lien » donne lienRefuse ; un code inconnu donne la phrase d'erreur générale.
 */
export function phraseErreur(code: FichiersCode | string, route: FichiersRoute): string {
  const t = TEXTES.partout;
  switch (code) {
    case "invalide":
      return t.invalide;
    case "trop-long":
      return t.tropLongRequete;
    case "fichiers-coupes":
      return t.coupe;
    case "protege":
      return route === "contenu" ? t.protegeFichier : t.protegeDossier;
    case "lien":
      return t.lienRefuse;
    case "plusieurs-noms":
      return t.plusieursNoms;
    case "projet-inconnu":
      return t.projetInconnu;
    case "introuvable":
      return t.introuvable;
    case "pas-un-dossier":
      return t.pasUnDossier;
    case "pas-un-fichier":
      return t.pasUnFichier;
    case "a-change":
      return t.aChange;
    case "illisible":
      return t.illisible;
    case "occupe":
      return t.occupe;
    default:
      return t.erreur;
  }
}

/** Nombre entier positif, sinon 0 : aucune phrase n'annonce 0, un nombre négatif ou fractionnaire. */
const compte = (n: number): number => (Number.isInteger(n) && n > 0 ? n : 0);

/** « 1 élément protégé… » ou « {n} éléments protégés… » ; null s'il n'y en a aucun. */
export function phraseMasques(n: number): string | null {
  const k = compte(n);
  if (k === 0) return null;
  return k === 1 ? TEXTES.partout.masquesUn : remplir(TEXTES.partout.masquesPlusieurs, { n: k });
}

/** Bandeau des caractères invisibles ; null s'il n'y en a aucun. */
export function phraseInvisibles(n: number): string | null {
  const k = compte(n);
  if (k === 0) return null;
  return k === 1 ? TEXTES.partout.invisibleUn : remplir(TEXTES.partout.invisiblesPlusieurs, { n: k });
}

/** Bandeau des lignes trop longues coupées ; null s'il n'y en a aucune. */
export function phraseLignesCoupees(n: number): string | null {
  const k = compte(n);
  if (k === 0) return null;
  return k === 1 ? TEXTES.partout.ligneCoupee : remplir(TEXTES.partout.lignesCoupees, { n: k });
}
