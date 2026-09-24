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
    // <c5:exemples-5b>
    /**
     * Exemples d'équipe ajoutés par la 5b (L45b ; conception C §12.1) et contrôle SQL local de « Revue SQL sur réplica ».
     * Les deux exemples de l'itération 4 gardent leurs textes dans `team-texts.ts` : ils ne sont jamais réécrits. Les quatre
     * exemples d'ici écrivent leurs textes dans ce fichier, qui appartient à la construction (§2.7) ; `team-texts.ts` est de
     * la vague 1 (L42a) et n'est pas touché.
     * Vocabulaire : « avis », jamais « regard » ; aucune étape ne conclut à la place de l'équipe (§6, P3).
     * D-5-25 : `enquete-incident` est livré SANS l'étape facultative « Avocat du diable », `revue-sql` SANS « Seconde lecture
     * de la synthèse ». Le contrôle SQL local, lui, est toujours livré : `sqlRepere` est la ligne que la feuille de lancement
     * de `revue-sql` affiche, sans aucun appel d'IA.
     */
    exemplesEquipes: {
      /**
       * Contrôle SQL LOCAL (C §12.1) : mots d'écriture repérés par `shared/sql-keywords.ts` dans la demande écrite, annoncés
       * avant l'envoi. Le cockpit dit ce qu'il a repéré, jamais que la requête écrit.
       */
      sqlRepere: "Repéré dans la requête : {mots} — la synthèse le signalera en premier.",
      "enquete-incident": {
        titre: "Enquête sur un incident",
        description:
          "Trois pistes sont examinées sans se voir : changement récent, infrastructure et dépendances, données et traitements. Une synthèse rassemble leurs avis, dit ce qui reste à vérifier et ne conclut pas à la place de l'équipe.",
        etapes: {
          changement: {
            titre: "Changement récent",
            consigne:
              "Cherche la cause de l'incident du côté des changements récents seulement : mises en production, correctifs, réglages, droits, certificats, tâches planifiées. Donne un tableau de cinq hypothèses au plus : indice pour, indice contre, contrôle en lecture seule qui départage, état (écartée, possible, probable). Chaque indice cite ce que tu as lu ; sans source, écris « À VÉRIFIER ». D'autres étapes examinent l'infrastructure et les données : ne les traite pas. Écris les causes en termes de systèmes et de procédures, jamais de personnes.",
          },
          infrastructure: {
            titre: "Infrastructure et dépendances",
            consigne:
              "Cherche la cause de l'incident du côté de l'infrastructure et des dépendances seulement : serveurs, réseau, stockage, certificats, services extérieurs, saturation, redémarrages. Donne un tableau de cinq hypothèses au plus : indice pour, indice contre, contrôle en lecture seule qui départage, état (écartée, possible, probable). Chaque indice cite ce que tu as lu ; sans source, écris « À VÉRIFIER ». D'autres étapes examinent les changements récents et les données : ne les traite pas.",
          },
          donnees: {
            titre: "Données et traitements",
            consigne:
              "Cherche la cause de l'incident du côté des données et des traitements seulement : volumes inhabituels, traitements de nuit, files d'attente, verrous, reprises après échec, données incomplètes ou en double. Donne un tableau de cinq hypothèses au plus : indice pour, indice contre, contrôle en lecture seule qui départage, état (écartée, possible, probable). Chaque indice cite ce que tu as lu ; sans source, écris « À VÉRIFIER ». D'autres étapes examinent les changements récents et l'infrastructure : ne les traite pas.",
          },
          synthese: {
            titre: "Synthèse de l'enquête",
            consigne:
              "Rassemble les avis reçus en un seul rapport. Commence par la piste la plus probable et l'avis qui la porte. Puis un tableau unique, sans doublon : hypothèse, indices pour, indices contre, contrôle qui départage, avis qui la citent. Écris « avis concordants » quand plusieurs avis citent le même point : ce n'est pas une preuve. Ajoute « Points de désaccord » quand les avis se contredisent, et « Ce qui reste à vérifier » avec le contrôle à faire pour chaque point. Ne conclus pas que l'incident est expliqué : la décision appartient à l'équipe.",
          },
        },
      },
      "revue-changement-cab": {
        titre: "Revue d'un changement avant le comité",
        description:
          "Prépare un changement pour le comité : rayon d'impact et retour arrière, une pause pour compléter ce qui manque, puis un pré-mortem. Un dernier rapport rassemble le tout sans décider à la place du comité.",
        pause: "Complétez les points manquants avant le pré-mortem.",
        etapes: {
          impact: {
            titre: "Rayon d'impact et retour arrière",
            consigne:
              "Relis le changement proposé pour son rayon d'impact et son retour arrière seulement. Donne, dans cet ordre : ce qui est touché et qui est gêné, réversible ou non ; les étapes exactes du retour arrière, quand s'en servir et ce qui ne se défait pas ; la façon de vérifier après coup, sur un périmètre réduit si possible. Écris « IRRÉVERSIBLE » et « À VÉRIFIER : sauvegarde testée ? » quand c'est le cas. Termine par la liste des informations qui manquent au dossier. Ne lance aucune commande et ne modifie rien.",
          },
          premortem: {
            titre: "Pré-mortem du changement",
            consigne:
              "Imagine que ce changement a échoué, en tenant compte du résultat reçu. Donne les cinq raisons les plus probables, chacune liée à une étape ou à un composant précis de ce plan, avec : le signal visible en premier, la façon de l'éviter, l'équipe concernée. N'invente aucun composant : ce que tu n'as pas lu est « À VÉRIFIER ». Termine par le point le plus fragile du plan, en une ligne. Ne rassure pas.",
          },
          dossier: {
            titre: "Dossier pour le comité",
            consigne:
              "Rassemble les résultats des étapes précédentes en un seul dossier. Commence par le résumé du changement en trois lignes : ce qui change, quand, qui est touché. Puis un tableau unique, sans doublon : gravité (bloquant, important, mineur), point, conséquence, ce qui est proposé, étape qui le signale. Ajoute « Retour arrière » avec les étapes exactes, « Points de désaccord » quand les résultats se contredisent, et « Questions pour le comité ». Ne dis pas que le changement peut partir : la décision appartient au comité.",
          },
        },
      },
      postmortem: {
        titre: "Compte rendu d'incident relu",
        description:
          "Un assistant rédige le compte rendu de l'incident avec la méthode « 5 pourquoi », vous vérifiez le premier jet, puis un relecteur critique le relit ; 2 tours au maximum.",
        etapes: {
          redaction: {
            titre: "Rédaction du compte rendu",
            consigne:
              "Rédige le compte rendu de l'incident à partir des notes, des extraits de journaux et de la chronologie fournis : résumé, impact mesuré, chronologie, causes, ce qui a marché, ce qui n'a pas marché, puis les actions avec un rôle responsable, une échéance et un résultat observable. Marque chaque fait Vérifié, Déduit ou À VÉRIFIER. Écris les causes en termes de systèmes et de procédures, jamais de personnes. Ne modifie rien et ne lance aucune commande.",
          },
          relecture: {
            titre: "Relecture critique",
            consigne:
              "Relis le compte rendu reçu avec ta liste de contrôle : chaque fait est-il tenu par une source citée, l'impact est-il chiffré, la chronologie est-elle complète, les causes remontent-elles à une cause sur laquelle on peut agir, chaque action a-t-elle un rôle responsable, une échéance et un résultat observable ? Donne les défauts situés, du plus grave au plus léger, avec l'extrait concerné et la correction proposée. Ne réécris pas le compte rendu et ne change pas une conclusion sourcée sans fait nouveau.",
          },
        },
      },
      "tri-alerte": {
        titre: "Tri d'une alerte",
        description:
          "Un aiguilleur propose, dans une liste fixe, le ou les spécialistes de l'alerte ; vous confirmez son choix. Deux spécialistes au plus l'expliquent, puis une synthèse rassemble leurs avis.",
        etapes: {
          aiguilleur: {
            titre: "Choix du spécialiste",
            consigne:
              "Lis l'alerte et choisis, dans la liste proposée, le ou les spécialistes les mieux placés pour l'expliquer. Donne une raison d'une ligne par choix, tirée du texte de l'alerte. Si aucun ne convient, dis-le : n'en choisis pas un par défaut.",
          },
          supervision: {
            titre: "Supervision et seuils",
            consigne:
              "Explique l'alerte du côté de la supervision seulement : ce que la sonde mesure vraiment, le seuil et sa fenêtre, la fréquence des relevés, les alertes liées, les faux positifs connus. Dis ce qu'il faut regarder pour confirmer, en lecture seule. Ne propose aucune action qui modifie quelque chose. Ce que tu n'as pas lu est « À VÉRIFIER ».",
          },
          reseau: {
            titre: "Réseau et accès",
            consigne:
              "Explique l'alerte du côté du réseau et des accès seulement : liens, pare-feu, résolution de noms, certificats, temps de réponse, pertes. Dis ce qu'il faut regarder pour confirmer, en lecture seule, et ce qui distinguerait une panne réseau d'une panne du service. Ne propose aucune action qui modifie quelque chose. Ce que tu n'as pas lu est « À VÉRIFIER ».",
          },
          "base-de-donnees": {
            titre: "Base de données",
            consigne:
              "Explique l'alerte du côté de la base de données seulement : verrous, attentes, requêtes longues, espace disque, réplication en retard, sauvegardes en cours. Dis ce qu'il faut regarder pour confirmer, en lecture seule. Ne propose aucune requête qui écrit. Ce que tu n'as pas lu est « À VÉRIFIER ».",
          },
          application: {
            titre: "Application et traitements",
            consigne:
              "Explique l'alerte du côté de l'application et des traitements seulement : files d'attente, traitements de nuit, reprises après échec, mémoire, erreurs répétées dans les journaux, dépendances extérieures. Dis ce qu'il faut regarder pour confirmer, en lecture seule. Ne propose aucune action qui modifie quelque chose. Ce que tu n'as pas lu est « À VÉRIFIER ».",
          },
          stockage: {
            titre: "Stockage et sauvegardes",
            consigne:
              "Explique l'alerte du côté du stockage et des sauvegardes seulement : espace restant, croissance, fichiers temporaires, instantanés, sauvegardes en cours ou en échec, lenteurs d'écriture. Dis ce qu'il faut regarder pour confirmer, en lecture seule. Ne propose aucune suppression. Ce que tu n'as pas lu est « À VÉRIFIER ».",
          },
          synthese: {
            titre: "Synthèse de l'alerte",
            consigne:
              "Rassemble les avis reçus en un seul rapport. Commence par ce que l'alerte veut dire, en une ligne. Puis un tableau unique, sans doublon : point, ce qu'il faut regarder pour le confirmer, avis qui le citent. Écris « avis concordants » quand plusieurs avis citent le même point : ce n'est pas une preuve. Ajoute « Points de désaccord » quand les avis se contredisent, et « Ce qui reste à vérifier ». Ne conclus pas que l'alerte est traitée : la décision appartient à l'équipe.",
          },
        },
      },
    },
    // </c5:exemples-5b>
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
      // <c5:editeur-l42d>
      // Trois libellés posés par L42d, que le §4.3 ne fixe pas à l'octet : le choix « Le résultat d'étapes choisies » du champ
      // « Ce que l'étape reçoit » (mode Avancé seulement, `recoit: {etapes}` de L42a ; il ne peut pas rejoindre
      // `editeur.champs.recoitChoix` de team-texts.ts, dont le croisement de V0 de l'it4 exige les trois noms de STEP_INPUTS et
      // rien d'autre), et les deux commandes de la liste des spécialistes, écrites comme celles des avis (T4t : « Ajouter un
      // avis », « Retirer cet avis ») pour que leur nom accessible dise de quoi il s'agit.
      recoitEtapes: "Le résultat d'étapes choisies",
      ajouterSpecialiste: "Ajouter un spécialiste",
      retirerSpecialiste: "Retirer ce spécialiste",
      // </c5:editeur-l42d>
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
      // <c5:reprise-redemarrage>
      /**
       * Clôture 5b (D-5b-1) : pause reprise après un redémarrage du cockpit, sans l'estimation de la suite (elle ne vivait qu'en
       * mémoire). Chaque phrase dit ce qui s'est passé et ce qu'il reste à faire. Rien n'est envoyé ni facturé avant votre
       * confirmation : le serveur refuse toute réponse qui lancerait un appel (`reestimation-requise`) et le dit aussi.
       * `confirmationReprend` ne vaut que pour la pause « Le cockpit a redémarré », que la confirmation fait repartir ; toute
       * autre pause revient telle quelle (`confirmationPause`), et c'est votre réponse qui la fait repartir.
       */
      reprise: {
        note: "Le cockpit a redémarré pendant cette pause : l'estimation de la suite n'a pas été gardée. Refaites-la avant de continuer ; rien n'est envoyé ni facturé avant votre confirmation.",
        aucunLibre: "« Aucun ne convient » reste possible sans nouvelle estimation : il ne lance aucun appel.",
        impossible: "Le cockpit a redémarré pendant cette pause, et la demande de l'équipe n'est plus disponible : aucune étape ne peut plus partir.",
        impossibleSuite: "Arrêtez l'équipe, puis relancez-la depuis la saisie.",
        bouton: "Refaire l'estimation de la suite",
        raison: "Refaites d'abord l'estimation de la suite.",
        confirmationTitre: "Reprendre avec cette estimation ?",
        confirmationReprend: "L'équipe reprend dès votre confirmation.",
        confirmationPause: "La pause reste affichée : rien ne part avant votre réponse.",
      },
      // </c5:reprise-redemarrage>
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
        // <c5:ecarts-accord>
        // Corrections de la relecture de la vague 2 : le PRÉVU s'accorde comme le réel, et séparément de lui. Un bloc neuf de
        // l'éditeur réserve UN tour (`toursMax: 1`) et UN spécialiste (`choixMax: 1`) : sans ces gabarits, la phrase affichée
        // EN GRAS sous le bilan du Déroulé disait « Prévu : jusqu'à 1 tours » et « jusqu'à 1 spécialistes ».
        ecartTourUnTourUn: "Prévu : jusqu'à {n} tour · Réel : {m} tour",
        ecartTourUnToursPlusieurs: "Prévu : jusqu'à {n} tour · Réel : {m} tours",
        ecartSpecialisteUn: "Prévu : jusqu'à {n} spécialiste · Réel : {m}",
        // </c5:ecarts-accord>
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

// <c5:ecarts-l42c>
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
 * Le prévu garde « jusqu'à », car c'est un plafond, jamais une promesse. Les deux nombres s'accordent SÉPARÉMENT : un bloc de
 * relecture neuf ne réserve qu'un tour, et « jusqu'à 1 tours » se lisait alors en gras sous le bilan du Déroulé. `compte(-1)`
 * vaut 0, donc « jusqu'à 0 tours » reste au pluriel.
 */
export function ecartTours(prevu: number, reel: number): string {
  const deroule = TEXTES.partout.execution.deroule;
  const n = compte(prevu);
  const m = compte(reel);
  if (n === 1) return remplir(m === 1 ? deroule.ecartTourUnTourUn : deroule.ecartTourUnToursPlusieurs, { n, m });
  return remplir(m === 1 ? deroule.ecartTourUn : deroule.ecartToursPlusieurs, { n, m });
}

/**
 * Écart « Prévu / Réel » des spécialistes d'un aiguillage (L42c) : « Prévu : jusqu'à {n} spécialistes · Réel : {m} ». Le réel
 * est un nombre nu — il vaut 0 quand aucun spécialiste de la liste ne convenait, et rien n'a alors été appelé. Le prévu
 * s'accorde : un aiguillage neuf ne retient qu'un spécialiste (`choixMax: 1`).
 */
export function ecartSpecialistes(prevu: number, reel: number): string {
  const deroule = TEXTES.partout.execution.deroule;
  const n = compte(prevu);
  return remplir(n === 1 ? deroule.ecartSpecialisteUn : deroule.ecartSpecialistes, { n, m: compte(reel) });
}

/** Répétition d'un bloc dans le Déroulé (L42c) : « ×{n} », écrit sur le bloc qui a travaillé plusieurs tours. */
export function repetitionBloc(tours: number): string {
  return remplir(TEXTES.partout.execution.deroule.repetition, { n: compte(tours) });
}
// </c5:ecarts-l42c>

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
