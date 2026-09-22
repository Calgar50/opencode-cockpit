// Textes de la construction (itération 5, plan d'exécution it5 §4.3, T5a ; spécification §2, §5.3, §5.4, §5.9, §6 ; C §3, §9.7,
// §9.9 à §9.14 ; RM §5). Convention TEXTES de T0, contrôlée par textes.test.ts sans modification de ce test : feuilles écrites
// « {nom} », jamais `${}` ; à côté de TEXTES, seules des fonctions s'exportent (secondReadingPrefix, annonceMiseAJour).
// Vocabulaire (§1.3 du plan, spécification §2.2 et §2.3) : « avis » jamais « regard » ; « vous confirmez son choix » jamais
// « vous validez » ; « Travaille » jamais « Réfléchit » ; « modèle » jamais pour une IA ; « jeton » seulement en section `avance`.
// Honnêteté (§6, P3), chaque phrase tenue par les paquets qui l'affichent :
// - « ≈ {x} $ » pour la Seconde lecture, jamais « au moins » (D-5-22) : l'entrée du Relecteur n'est pas celle de l'assistant
//   précédent, et un profil ou une moyenne n'est pas un minimum ; la base de l'estimation est nommée dans l'infobulle ;
// - « Une méthode guide la réponse ; elle ne garantit pas qu'elle est juste. » : une méthode n'ajoute aucun appel d'IA et ne
//   vérifie rien ; « Méthode appliquée » ne dit que la présence de la section attendue ;
// - « Relecture par un autre assistant » : la seconde lecture ne remplace ni un collègue ni le CAB ;
// - l'annonce ne propose une équipe que là où les équipes sont ouvertes (U1, D-5-24 : annonceMiseAJour).
import type { ConstructionErrorCode, SecondReadingEstimate, SecondReadingTarget } from "./construction-types.ts";

/** Bases d'estimation qui ont une phrase : toutes sauf « aucune », qui n'affiche aucun montant (§4.5). */
type BaseAvecPhrase = Exclude<SecondReadingEstimate["base"], "aucune">;

/** Premier guillemet ouvrant du message de seconde lecture : fin de son début fixe (secondReadingPrefix). */
const OUVRANT = "«";

/** Séparateur des phrases de l'annonce de mise à jour. */
const ESPACE = " ";

export const TEXTES = {
  simple: {},
  avance: {
    /** Méthodes : les sources ne sont montrées qu'en mode Avancé (spécification §5.4). */
    methodes: {
      sources: "Sources",
    },
    /** Chronologie (D-5-09) : « jeton » est interdit en mode Simple, la vue entière est donc réservée au mode Avancé. */
    chronologie: {
      titre: "Chronologie",
      deroule: "Déroulé",
      phrase: "Le déroulé détaillé : chaque appel d'IA, ses outils, ses jetons et son coût.",
      colonnes: {
        qui: "Qui",
        appel: "Appel",
        debut: "Début",
        duree: "Durée",
        ia: "IA",
        reflexion: "Réflexion",
        jetons: "Jetons (entrée / sortie / cache)",
        outils: "Outils",
        tentatives: "Tentatives",
        cout: "Coût",
      },
      maintenant: "maintenant",
      groupe: "{agent} ×{n}",
      voirAppels: "Voir les {n} appels",
      jetonsAbsents: "Jetons non enregistrés pour cet appel.",
      vide: "Aucun appel d'IA enregistré pour cette demande.",
    },
    /** Schéma modifiable (spécification §5.3, C §8.2) : réglage du mode Avancé, replié en liste sous 900 px. */
    schema: {
      etapes: "Étapes",
      titre: "Schéma modifiable",
      phrase: "Même équipe, deux façons de la modifier. Le schéma n'accepte que ce que le cockpit sait exécuter.",
      glisser: "Glissez vers une étape plus bas : elle recevra ce résultat.",
      refus: {
        versLeBas: "Le cockpit exécute les étapes de haut en bas : un lien ne peut aller que vers une étape plus bas.",
        retourArriere: "Seule une relecture revient en arrière, 2 tours au maximum.",
        condition: "Pas de condition libre : seuls le verdict d'une relecture et le choix d'un aiguillage changent la suite.",
        imbrication: "Un bloc ne peut pas en contenir un autre.",
      },
      menus: {
        ajouterApres: "Ajouter après",
        monter: "Monter",
        descendre: "Descendre",
        transformer: "Transformer en…",
        recevoir: "Reçoit le résultat de…",
        supprimer: "Supprimer",
      },
      json: {
        voir: "Voir le JSON",
        lectureSeule: "Lecture seule. Pour partager une équipe, utilisez « Dupliquer » ; l'import viendra plus tard.",
      },
      etroit: "Le schéma modifiable demande un écran plus large : utilisez les étapes.",
    },
    // <c5:vue-ensemble-doc>
    /**
     * Vue d'ensemble de la carte des assistants (spécification §5.2) : les noms techniques y sont permis. Les huit libellés de
     * genre (« Vous » à « Fiches ») servent DEUX FOIS : ils titrent un groupe de la vue et nomment la puce de filtre qui le
     * montre — un groupe, une puce, un libellé (L48).
     */
    // </c5:vue-ensemble-doc>
    vueEnsemble: {
      titre: "Vue d'ensemble",
      vous: "Vous",
      raccourcis: "Raccourcis",
      equipes: "Équipes",
      assistants: "Assistants",
      integres: "Intégrés",
      agentsStudio: "Agents du Studio",
      sousAgents: "Sous-agents",
      fiches: "Fiches",
      aide: "Survolez ou sélectionnez un élément pour n'afficher que ses liens.",
      horsSujet: "(hors sujet)",
      // <c5:vue-ensemble-groupes>
      // Deux noms de groupe ajoutés par L48, qui n'annoncent aucune fonction de plus : le groupe des puces de filtre, et la
      // reprise EN TEXTE des liens, exigée parce que les connecteurs SVG sont décoratifs (aria-hidden, §5.2).
      // Section posée par l'intégrateur au train de V1 : ce fichier est de classe A (§2.6), donc tout ajout y est balisé.
      /** Groupe des puces de filtre (nom accessible). */
      filtres: "Afficher",
      /** Reprise en toutes lettres de chaque lien dessiné : la vue se lit sans le dessin. */
      liens: "Liens",
      // </c5:vue-ensemble-groupes>
    },
  },
  partout: {
    /** Méthodes (C §5.4, RM §5.2, D-5-07, D-5-08). */
    methodes: {
      /** État vide de la vue Méthodes (spécification §5.4, l.910). */
      vide: "Une méthode guide la réponse ; elle ne garantit pas qu'elle est juste.",
      carte: {
        sansAppel: "Aucun appel d'IA en plus",
        quand: "Quand : {quand}",
        attention: "Attention : {attention}",
        utiliseePar: "Utilisée par : {assistants}",
        texteExact: "Texte exact",
        ajouterAssistant: "Ajouter à un assistant",
        conseillees: "Méthodes conseillées",
        ajouter: "Ajouter",
      },
      creation: {
        titre: "Méthodes (facultatif)",
        phrase: "Aucun appel d'IA en plus : le texte de la méthode s'ajoute aux consignes de l'assistant.",
        conseillee: "Conseillée pour cet assistant",
      },
      limites: {
        trop: "2 méthodes au maximum : au-delà, l'assistant les applique moins bien.",
        deja: "Déjà appliquée par l'assistant.",
        raccourci: "Les méthodes ne s'ajoutent pas à un raccourci.",
        sansTexte: "Les méthodes ne partent qu'avec un message écrit.",
        equipe: "Les méthodes d'une équipe se règlent sur ses étapes.",
      },
      fiche: {
        liste: "Méthodes : {liste}",
        phrase: "Une méthode guide la façon de répondre ; elle ne garantit pas que la réponse est juste.",
      },
      /**
       * Confirmation d'« Ajouter à un assistant » quand l'enregistrement remplacerait l'IA précise de l'assistant (corrections
       * de la relecture de 5a V2). Honnêteté (§6, P3) : l'ajout d'une méthode réenregistre le brouillon complet, et le mode
       * Simple ne peut pas renvoyer une IA précise — l'IA change donc, avec son coût et sa façon de répondre. Cela se dit
       * AVANT l'envoi. La seconde phrase sert quand le niveau de repli ne résout aucune IA : rien n'est alors inventé.
       */
      iaPrecise: {
        remplacee:
          "Cet assistant utilise une IA précise (« {ia} »). En mode Simple, enregistrer une méthode la remplace par l'IA du niveau {niveau} (« {nouvelle} »). Pour garder cette IA, passez en mode Avancé ou par « Modifier ».",
        remplaceeSansNom:
          "Cet assistant utilise une IA précise (« {ia} »). En mode Simple, enregistrer une méthode la remplace par l'IA du niveau {niveau}. Pour garder cette IA, passez en mode Avancé ou par « Modifier ».",
      },
      puce: {
        ajouter: "+ Méthode",
        choisie: "Méthode : {titre}",
        retirer: "Retirer la méthode {titre}",
        apercu: "Ce texte sera ajouté à la fin de votre message : ",
      },
      bulle: {
        demandee: "Méthode demandée : {titre}",
      },
      detection: {
        appliquee: "Méthode appliquée",
        absente: "Méthode non détectée dans la réponse",
        infobulle: "Le cockpit vérifie seulement que la section attendue est présente, pas que le raisonnement est juste.",
      },
    },
    /** Seconde lecture (C §9.7, RM §5.4, D-5-06, D-5-22 ; accepté par A5 : montant au bouton, base en infobulle). */
    secondeLecture: {
      bouton: "Seconde lecture (≈ {x} $)",
      infobulle: "Un autre assistant (Relecteur critique, {ia}) relit la réponse avec une liste de contrôle. Il voit toute la conversation : le coût dépend de sa longueur.",
      /** Phrase de base, ajoutée à l'infobulle ; `aucune` n'en a pas (aucune estimation n'est alors affichée). */
      base: {
        conversation: "Estimation d'après la longueur actuelle de la conversation.",
        observe: "Estimation d'après ses relectures précédentes.",
        profil: "Estimation pour une conversation courte : une longue conversation coûte davantage.",
      } satisfies Record<BaseAvecPhrase, string>,
      message:
        "Seconde lecture de la réponse précédente de « {assistant} ». Vérifie-la avec ta liste de contrôle. Relis les fichiers cités si tu y as accès. Ne change pas une conclusion sourcée sans fait nouveau.",
      messageEquipe:
        "Seconde lecture du résultat de l'équipe « {equipe} ». Vérifie-le avec ta liste de contrôle. Relis les fichiers cités si tu y as accès. Ne change pas une conclusion sourcée sans fait nouveau.",
      pied: "Relecture par un autre assistant : elle ne remplace ni la relecture par un collègue ni le CAB.",
      absente: "Installez l'assistant « Relecteur critique » pour demander une seconde lecture.",
      occupee: "Attendez la fin de la réponse en cours.",
    },
    /** Assistants d'équipe (L45a) : onglet du catalogue. */
    assistantsEquipe: {
      titre: "Assistants des équipes ({n})",
      phrase: "Ils travaillent surtout dans les équipes ; vous pouvez aussi les utiliser seuls.",
    },
    /** Coûts par équipe (D-5-10). */
    couts: {
      parEquipe: "Par équipe",
      colonnes: {
        equipe: "Équipe",
        lancements: "Lancements",
        cout: "Coût",
        moyenne: "Moyenne par lancement",
        estime: "Estimé en général",
      },
      plusCouteux: "Lancements d'équipe les plus coûteux",
      vide: "Aucune équipe lancée ce mois-ci.",
      equipeSupprimee: "Équipe supprimée",
      ouvrir: "Ouvrir la conversation",
    },
    /** Archives (D-5-10, D-5-11). */
    archives: {
      filtre: "Avec une équipe",
      titre: "Équipes lancées dans cette conversation",
      etape: "Étape « {titre} » · {assistant} · {ia} · {etat} · {cout}",
      extrait: "Extrait du résultat (données masquées)",
      detailIndisponible: "Détail des étapes indisponible : conversation supprimée d'opencode. Coûts conservés.",
      titreMarkdown: "Déroulé de l'équipe « {equipe} »",
    },
    /** Formes livrées par la 5b (§1.3 : « vous confirmez son choix », jamais « vous validez »). */
    formes: {
      relecture: {
        titre: "Rédaction et relecture",
        phrase: "Un assistant rédige, un autre relit ; 2 tours au maximum.",
        tour: "Un tour = une relecture, puis une correction si nécessaire.",
      },
      aiguillage: {
        titre: "Aiguillage",
        phrase: "Un premier assistant propose le bon spécialiste dans une liste fixe ; vous confirmez son choix.",
      },
    },
    /** Éditeur guidé (5b). */
    editeur: {
      champs: {
        redacteur: "Rédacteur",
        relecteur: "Relecteur",
        tours: "Nombre de tours au maximum",
        pause: "Me laisser vérifier le premier jet avant la relecture",
        aiguilleur: "Aiguilleur",
        specialistes: "Spécialistes",
        specialistesMax: "Spécialistes à consulter au plus",
        synthese: "Synthèse",
        methodes: "Méthodes (facultatif, 2 au plus)",
      },
      aide: "Pour une relecture plus indépendante, donnez au relecteur une autre IA que le rédacteur.",
      menu: {
        relecture: "Une rédaction et relecture",
        aiguillage: "Un aiguillage",
      },
    },
    /** Problèmes du déroulé (5b, L42a) : une phrase par code. `meme-famille` est un avertissement, pas un refus. */
    problemes: {
      "aiguillage-premier": "Un aiguillage ne peut être que le premier bloc.",
      specialistes: "Proposez de 2 à 8 spécialistes.",
      "synthese-requise": "Avec 2 spécialistes possibles, ajoutez une étape de synthèse.",
      "relecteur-distinct": "Le relecteur doit être un autre assistant, ou le même avec une autre IA.",
      "meme-famille": "Rédacteur et relecteur utilisent la même famille d'IA : la relecture sera moins indépendante.",
      "lien-arriere": "Une étape ne peut recevoir que le résultat d'étapes situées plus haut.",
      "lien-avis": "Les avis indépendants ne se voient pas entre eux.",
      "lien-avance": "Réglage du mode Avancé.",
      methodes: {
        trop: "2 méthodes au maximum par étape.",
        deja: "Déjà appliquée par l'assistant.",
      },
    },
    /** Exécution d'une équipe (5b) : carte de choix d'un aiguillage, journal de relecture, estimations. */
    execution: {
      choix: {
        titre: "Choisissez le ou les spécialistes",
        proposition: "L'aiguilleur propose « {choix} » : « {raison} ». C'est la proposition d'une IA : vérifiez-la.",
        maximum: "{n} au maximum.",
        continuer: "Continuer avec {n} spécialiste(s) (≈ {x} $)",
        aucunConvient: "Aucun ne convient",
        arreter: "Arrêter l'équipe",
        illisible: "L'aiguilleur n'a pas donné de choix lisible : choisissez vous-même.",
      },
      aucun: {
        phrase: "Aucun spécialiste de la liste ne convient.",
        repli: "Pour une explication générale, envoyez votre demande à « {assistant} ».",
        envoyer: "Envoyer à cet assistant",
      },
      relecture: {
        journal: "Journal de relecture",
        tour: "tour {n}",
        aReprendre: "À reprendre",
        rienAReprendre: "Rien à reprendre",
        verdictIllisible: "Verdict illisible : traité comme « à reprendre ».",
        nonRelue: "Non relue après la dernière correction.",
        nonConclue: "Relecture non conclue après {n} tours : points restants ci-dessous.",
      },
      estimation: {
        tours: "1 tour en général, {n} au plus",
        specialistes: "1 spécialiste en général, {n} au plus",
      },
      etat: {
        nonChoisi: "Non choisi",
      },
      /** Déroulé d'équipe (L42c) : « ×{n} » et les deux écarts Prévu / Réel, formatés par les fonctions de L42c. */
      deroule: {
        repetition: "×{n}",
        ecartTourUn: "Prévu : jusqu'à {n} tours · Réel : {m} tour",
        ecartToursPlusieurs: "Prévu : jusqu'à {n} tours · Réel : {m} tours",
        ecartSpecialistes: "Prévu : jusqu'à {n} spécialistes · Réel : {m}",
      },
    },
    /** Liens entre étapes et méthodes des étapes (5b, L42a ; en-tête du message d'étape, C §6.3). */
    liens: {
      recoit: "Reçoit le résultat de : {etapes}",
      enTeteMethode: "## Méthode : {titre}",
    },
    /** Démonstration d'équipe (spécification §5.9, l.1013 ; D-5-15 : lecteur de l'itération 1 dans la branche). */
    demonstration: {
      titre: "Comment se déroule une équipe",
      etiquette: "Démonstration enregistrée : aucune IA n'est appelée",
      phrase: "Déroulé enregistré avec des données fictives.",
      voir: "Voir une démonstration",
      bascule: {
        aLaSuite: "À la suite",
        enMemeTemps: "En même temps",
      },
    },
    /**
     * Annonce de la 1.1.0 (L51, C §9.14 corrigée par D-5-24) : assemblée par annonceMiseAJour, jamais lue morceau par morceau.
     * `bientot` est la phrase de l'itération 4, reprise à l'octet, affichée quand les équipes sont fermées dans le mode courant.
     */
    annonce: {
      titreOuvertes: "Nouveau : voir qui travaille, et faire travailler une équipe",
      titreFermees: "Nouveau : voir qui travaille",
      debut: "Pendant une demande, « Qui travaille ? » montre chaque assistant au travail, son temps et son coût. La carte des assistants montre qui peut faire travailler qui.",
      equipe: "Vous pouvez aussi lancer une équipe prête à l'emploi.",
      fin: "Rien n'a été modifié dans vos assistants.",
      bientot: "Les équipes arrivent bientôt en mode Simple. En mode Avancé, vous pouvez déjà les essayer.",
      voirCarte: "Voir la carte",
      compris: "Compris",
    },
    /** Une phrase par ConstructionErrorCode (§4.5) : un code ajouté sans sa phrase fait échouer le typecheck. */
    erreurs: {
      "methodes-trop": "2 méthodes au maximum : au-delà, l'assistant les applique moins bien.",
      "methode-inconnue": "Méthode inconnue du cockpit.",
      "methode-non-attachable": "Les méthodes ne s'ajoutent pas à un raccourci.",
      "seconde-lecture-absente": "Installez l'assistant « Relecteur critique » pour demander une seconde lecture.",
      "racine-inconnue": "Conversation inconnue du cockpit.",
    } satisfies Record<ConstructionErrorCode, string>,
  },
};

/**
 * Début fixe du message de seconde lecture, jusqu'au premier guillemet ouvrant : ce que le crochet `secondReading` reconnaît
 * pour requalifier le tour (D-5-06). Le nom de l'assistant ou de l'équipe qui suit n'en fait pas partie.
 */
export function secondReadingPrefix(cible: SecondReadingTarget): string {
  const message = cible === "equipe" ? TEXTES.partout.secondeLecture.messageEquipe : TEXTES.partout.secondeLecture.message;
  const at = message.indexOf(OUVRANT);
  return at === -1 ? message : message.slice(0, at);
}

/** Remplit un gabarit « {nom} » ; un nom absent des valeurs garde son gabarit. */
function remplir(gabarit: string, valeurs: Readonly<Record<string, string | number>>): string {
  return gabarit.replace(/\{(\w+)\}/g, (match: string, nom: string) => (Object.hasOwn(valeurs, nom) ? String(valeurs[nom]) : match));
}

/** Nombre montré dans un écart : entier, jamais négatif — le Déroulé ne compte pas ce qu'il n'a pas enregistré. */
function compte(valeur: number): number {
  return Number.isFinite(valeur) ? Math.max(0, Math.trunc(valeur)) : 0;
}

/**
 * Écart « Prévu / Réel » des tours d'une relecture (L42c ; conception A §7.3 : « Prévu : jusqu'à 2 tours · Réel : 1 tour »).
 * Le singulier du réel suit le nombre de tours RÉELLEMENT faits ; le prévu garde « jusqu'à », car c'est un plafond, jamais une
 * promesse.
 */
export function ecartTours(prevu: number, reel: number): string {
  const deroule = TEXTES.partout.execution.deroule;
  const m = compte(reel);
  return remplir(m === 1 ? deroule.ecartTourUn : deroule.ecartToursPlusieurs, { n: compte(prevu), m });
}

/**
 * Écart « Prévu / Réel » des spécialistes d'un aiguillage (L42c) : « Prévu : jusqu'à {n} spécialistes · Réel : {m} ». Le réel
 * est un nombre nu — il vaut 0 quand aucun spécialiste de la liste ne convenait, et rien n'a alors été appelé.
 */
export function ecartSpecialistes(prevu: number, reel: number): string {
  return remplir(TEXTES.partout.execution.deroule.ecartSpecialistes, { n: compte(prevu), m: compte(reel) });
}

/** Répétition d'un bloc dans le Déroulé (L42c) : « ×{n} », écrit sur le bloc qui a travaillé plusieurs tours. */
export function repetitionBloc(tours: number): string {
  return remplir(TEXTES.partout.execution.deroule.repetition, { n: compte(tours) });
}

/**
 * Annonce de la 1.1.0 (D-5-24, U1). Équipes ouvertes dans le mode courant : le titre et le texte proposent une équipe.
 * Équipes fermées : même texte sans cette phrase, suivi de la phrase de l'itération 4. Aucun appelant ne compose lui-même.
 */
export function annonceMiseAJour(options: { equipesOuvertes: boolean }): { titre: string; texte: string } {
  const annonce = TEXTES.partout.annonce;
  const phrases = options.equipesOuvertes ? [annonce.debut, annonce.equipe, annonce.fin] : [annonce.debut, annonce.fin, annonce.bientot];
  return {
    titre: options.equipesOuvertes ? annonce.titreOuvertes : annonce.titreFermees,
    texte: phrases.join(ESPACE),
  };
}
