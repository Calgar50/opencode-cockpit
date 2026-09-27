// Textes de la Salle OMO (spécification §3.12.1, §3.15, §4.8.2, §4.12, §4.14, §5.4, §5.7.2, §6 ; plan d'exécution 2 bis-2 ter
// §4.1.3, T3a) : écran d'activation, bandeau, tableau d'honnêteté, une phrase par code de chaque union de omo-types.ts (refus
// d'activation, arrêts, détections, interdits absolus, pré-contrôle, sorties refusées), états, relance à neuf, fichiers signalés,
// marques d'origine. Convention TEXTES de T0, contrôlée par textes.test.ts. Module pur (server/shared).
// - Salle réservée au mode Avancé : tout est en `avance`, sauf le refus « mode-avance » (lu en mode Simple), en `partout` ; rien en
//   `simple` avant « Revoir » (itération 3). « agent » et « orchestrateur » : mode Avancé seulement, avec le nom de rôle français
//   suivi du nom de l'agent entre parenthèses (« Orchestrateur (Sisyphus) », §2.3 l.104).
// - Reprises telles quelles de la spécification (l.401, 475, 521, 784, 829, 850, 856-858, 860-862, 866, 868, 915, 1053-1056,
//   1060-1063, 1066-1067 et fragments de §5.7.2, §5.7.4), gabarits renommés en ASCII : {montant saisi} → {montant},
//   {catégorie} → {categorie}. Phrases réécrites par D-2b-38 (l.859, l.863 = l.1057, l.864 = l.1058, l.1059, l.865), copiées à
//   l'octet du plan §4.1.3 ; errata consigné par DOC-OMO. Accents graves : nom de fichier ou de commande, rendu en code.
// - Honnêteté (P3) : « au plus » seulement pour l'homme mort (30 secondes, D-2b-25) et la borne {plafondMaxUsd} vérifiée par le
//   serveur ; le coût n'est jamais promis (« un appel en cours par assistant peut le dépasser ») ; une détection est après coup.
// - Gabarits : {projet}, {date}, {x}, {montant}, {plafondMaxUsd}, {categorie}, {liste}, {chemin}, {n} (omo-room-texts.test.ts).
import type {
  EgressRefusalReason,
  OmoActivationRefusalCode,
  OmoDetectionCause,
  OmoEtatSalle,
  OmoForbiddenCategory,
  OmoPrecheckReason,
  OmoProjectGitState,
  OmoRecreationEtat,
  OmoSignale,
  OmoStopCause,
} from "./omo-types.ts";

export const TEXTES = {
  simple: {},
  avance: {
    /** Écran d'activation, à chaque demande (§4.14.6). */
    activation: {
      titre: "Lancer cette demande comme Oh My OpenAgent ?",
      extension:
        "L'extension Oh My OpenAgent (version 4.19.4, auditée le {date}) enchaîne le travail seule : elle délègue, relance et résume sans vous demander.",
      autorise: "Autorisé automatiquement : lire et modifier les fichiers de {projet}, lancer des commandes, les tests et les programmes du projet.",
      /** l.859 réécrite (D-2b-38). */
      refuse:
        "Refusé automatiquement aux outils de l'IA (interdits absolus) : fichiers de clés et `.env`, production, réseau, envoi git, hors du projet, fichiers de configuration, d'IDE et de CI.",
      reseau: "Réseau fermé sauf GitHub Copilot.",
      champ: {
        libelle: "Arrêt automatique à :",
        unite: "$",
        /** Borne vérifiée par le serveur (omo-cap.ts). */
        borne: "au plus {plafondMaxUsd} $",
        aide: "Ses appels ne passent pas par le contrôle de coût avant envoi : le cockpit arrête à ce montant ; un appel en cours par assistant peut le dépasser.",
      },
      /** Seulement si G12 garde le planificateur avec edit: allow ; sinon planificateurControle. */
      planificateurSansDemande: "Le planificateur (Prometheus) modifie des fichiers sans demande, seulement filtré par l'extension.",
      planificateurControle: "Les modifications du planificateur passent par le contrôle des interdits du cockpit.",
      /** l.863 et l.1057 réécrites (D-2b-38). */
      programme:
        "Un programme lancé automatiquement peut lire et modifier les fichiers de tous les projets du dossier de travail, dont les `.env` et les fichiers de clés, lire le jeton Copilot et agir sur opencode. Le cockpit arrête tout s'il le détecte, après coup.",
      /** l.864 et l.1058 réécrites (D-2b-38). */
      fichiersExecutes:
        "Des fichiers écrits dans le dossier de travail peuvent s'exécuter plus tard sur votre poste. L'historique git de chaque projet reste en lecture seule ; une modification des fichiers d'IDE ou de CI arrête la demande et vous est signalée.",
      /** l.865 réécrite (D-2b-38, D-2b-29) ; « 30 secondes au plus » tenu par D-2b-25 (27 s). */
      arreter:
        "Arrêter relance la salle à neuf ; elle l'est aussi à la fin de chaque demande. Si le cockpit s'arrête, la salle s'arrête en 30 secondes au plus.",
      sansDemande: "Certaines actions de l'extension ne passent par aucune demande.",
      boutons: {
        lancer: "Lancer comme Oh My OpenAgent",
        annuler: "Annuler",
        sansDemande: "Ce que l'extension fait sans demande",
      },
    },
    /** Bandeau permanent d'une conversation de la salle (§4.12 l.784). */
    bandeau: {
      texte: "Salle OMO · extension active · actions non contrôlées avant exécution · {x} $ sur {montant} $",
      arreter: "Arrêter",
      journal: "Journal",
    },
    /** Tableau d'honnêteté (§6), formulations distinctes de l'écran d'activation (l.1057 et l.1058 : activation.programme et fichiersExecutes). */
    honnetete: {
      reseauFerme: "Réseau fermé sauf GitHub Copilot",
      delegue: "L'extension délègue, relance et résume sans vous demander",
      coutApresCoup:
        "Ses appels ne passent pas par le contrôle de coût avant envoi : le cockpit arrête à {montant} $ ; un appel en cours par assistant peut le dépasser",
      planificateurSansDemande: "Le planificateur (Prometheus) modifie des fichiers sans demande, seulement filtré par l'extension",
      planificateurControle: "Les modifications du planificateur passent par le contrôle des interdits du cockpit",
      /** l.1059 réécrite (D-2b-38). */
      interditsAbsolus: "Interdits absolus, refusés automatiquement aux outils de l'IA : fichiers de clés, production, réseau, envoi git.",
      arreterRelance: "Arrêter relance la salle à neuf",
      hommeMort: "Si le cockpit s'arrête, la salle s'arrête en 30 secondes au plus",
      version: "Version 4.19.4, auditée le {date} ; image construite sur votre PC, jamais publiée",
    },
    /** Refus d'activation (409, rien n'est envoyé), par code ; « mode-avance » est en `partout`. */
    refus: {
      "salle-coupee": "La Salle OMO est coupée sur ce cockpit.",
      "autonomie-coupee": "Autonomie coupée sur ce cockpit par son administrateur : la Salle OMO l'est aussi.",
      "racine-hors-salle": "Cette conversation n'a pas été ouverte dans la Salle OMO.",
      "confirmation-requise": "Confirmation requise à chaque demande : l'extension enchaîne le travail sans vous demander.",
      "plafond-vide": "Saisissez le montant d'arrêt automatique.",
      "plafond-invalide": "Montant invalide : saisissez un nombre positif avec deux décimales ou moins, par exemple 2 ou 0,50.",
      "plafond-hors-bornes": "Montant supérieur au maximum permis par le cockpit ({plafondMaxUsd} $) : saisissez un montant plus bas.",
      "budget-mensuel": "Le budget mensuel ne permet pas de lancer cette demande.",
      "precheck-refuse": "Le pré-contrôle de {projet} n'est pas conforme : rien n'a été lancé.",
      /**
       * Balayage de la salle (state.json). Aucun geste n'est promis : la mesure du banc (L21 §2) montre qu'un `.git` monté en
       * lecture seule reste inscriptible par ses alias de casse (`.GIT`, `GIT~1`) sur le partage de Docker Desktop, sur tous les
       * postes Windows visés ; relancer `install.ps1` reposerait les mêmes montages et ne changerait rien (P3, honnêteté).
       */
      "git-inscriptible": "L'historique git de ces dossiers n'est pas protégé : la salle ne démarre pas. {liste}",
      manifeste: "L'image de la salle ne correspond pas à son manifeste : la salle ne démarre pas.",
      "image-inattendue": "L'image de la salle chargée n'est pas celle de l'installation : relancez `install.ps1` avec son archive.",
      "battement-absent": "La salle ne répond pas : le cockpit ne peut pas vérifier qu'elle s'arrêtera.",
      "demande-active": "Une demande est déjà en cours dans la salle : attendez sa fin ou arrêtez-la.",
      /** l.475. */
      "adresse-copilot-changee": "Adresse Copilot changée : relancez l'installation",
      "catalogue-absent": "Catalogue des IA de votre compte GitHub Copilot indisponible : la demande n'est pas lancée.",
      "jeton-consomme": "Cette confirmation a déjà servi pour une demande : confirmez à nouveau.",
      "salle-suspendue": "Salle suspendue : l'extension a agi sans demande à deux reprises. Rouvrez une salle pour la relancer.",
      "salle-en-relance": "La salle redémarre à neuf. Réessayez dans quelques secondes.",
      /**
       * Balayage du cockpit : ces dépôts sont hors de `gitProteges`, donc ajoutés après l'installation. Ici le geste aboutit
       * vraiment — `install.ps1` leur posera leur montage — et la phrase le dit.
       */
      "workspace-non-verifie": "L'historique git de ces dossiers n'est pas protégé : relancez `install.ps1`. {liste}",
    } satisfies Record<Exclude<OmoActivationRefusalCode, "mode-avance">, string>,
    /** Arrêt de la salle (stopTreeOmo), par cause. */
    arrets: {
      vous: "Arrêtée par vous : la salle est relancée à neuf.",
      "plafond-cout":
        "Arrêtée : montant d'arrêt atteint ({x} $ sur {montant} $). Un appel en cours par assistant peut l'avoir dépassé ; GitHub Copilot peut facturer un appel interrompu.",
      "plafond-duree": "Arrêtée : durée maximale d'une demande dans la salle atteinte.",
      "plafond-sessions": "Arrêtée : nombre maximal de sessions créées par l'extension atteint.",
      "plafond-tentatives": "Arrêtée : trop de nouvelles tentatives d'affilée après des refus de débit de GitHub Copilot.",
      "seuil-mensuel": "Arrêtée : seuil mensuel du budget atteint. Le cockpit ne le confirme jamais automatiquement.",
      "hors-controle": "Arrêtée : le cockpit a repéré après coup une action hors de son contrôle.",
      "homme-mort": "Arrêtée : le cockpit ne répondait plus, la salle s'est arrêtée d'elle-même.",
      "redemarrage-cockpit": "Le cockpit a redémarré : la demande en cours a été arrêtée et la salle relancée à neuf.",
    } satisfies Record<OmoStopCause, string>,
    /** Détections (§4.14.5), toutes suivies de stopTreeOmo. */
    detections: {
      "reponse-non-emise": "Une demande d'autorisation a reçu une réponse que le cockpit n'a pas émise : le cockpit a tout arrêté.",
      "racine-etrangere": "Une conversation a été créée dans la salle sans passer par le cockpit : le cockpit a tout arrêté.",
      "dispose-non-demande": "opencode a été rechargé dans la salle sans que le cockpit le demande : le cockpit a tout arrêté.",
      "permission-modifiee": "Les permissions d'une session ont été modifiées sans le cockpit : le cockpit a tout arrêté.",
      "origine-inconnue": "Message non écrit par vous sur une conversation de la salle (origine non identifiée) : le cockpit a tout arrêté.",
      "config-apparue": "Un fichier de configuration est apparu dans le dossier de travail : le cockpit a tout arrêté.",
      "git-cree": "Un historique git a été créé pendant la demande : le cockpit a tout arrêté.",
      "ide-ci-modifie": "Un fichier d'IDE ou de CI a été modifié : le cockpit a tout arrêté.",
      "tentatives-429": "GitHub Copilot a refusé plusieurs nouvelles tentatives d'affilée : le cockpit a tout arrêté.",
      "activite-hors-demande": "L'extension a agi alors qu'aucune demande n'était en cours : la salle a été arrêtée.",
    } satisfies Record<OmoDetectionCause, string>,
    /** §4.14.5 l.851 : une détection est après coup. */
    detectionApresCoup: "Le cockpit l'a repéré après coup : un programme a pu agir avant l'arrêt.",
    /** Interdits absolus (§4.14.3) : message de refus remis à l'IA (l.829) et catégories. */
    interdits: {
      message: "Interdit absolu du cockpit : {categorie}. N'essayez pas de le contourner.",
      categories: {
        "fichier-cle": "fichiers de clés",
        env: "fichiers .env",
        production: "production",
        reseau: "réseau",
        "git-envoi": "envoi git",
        "git-options-globales": "options globales de git",
        "hors-projet": "hors du projet ouvert",
        "config-extension": "fichiers de configuration de l'extension et d'opencode",
        "ide-ci": "fichiers d'IDE et de CI",
        "git-interne": "historique git (.git)",
        web: "accès web",
      } satisfies Record<OmoForbiddenCategory, string>,
    },
    /** Pré-contrôle d'un projet (§3.15.2), par raison ; la liste masquée des chemins trouvés suit la phrase. */
    precontrole: {
      "config-extension": "Fichier de configuration de l'extension trouvé dans le projet ou un dossier parent : projet refusé.",
      "config-opencode": "Fichier de configuration d'opencode trouvé dans le projet ou un dossier parent : projet refusé.",
      "fichier-cle": "Fichier de clés trouvé à la racine du projet ou dans un dossier parent : projet refusé.",
      "lien-symbolique": "Lien symbolique trouvé : le cockpit ne le suit pas et refuse le projet.",
      illisible: "Fichier illisible : le cockpit ne peut pas le vérifier et refuse le projet.",
      profondeur: "Arborescence trop profonde pour être vérifiée : projet refusé.",
      "hors-workspace": "Projet hors du dossier de travail : refusé.",
      /** l.1063. */
      "non-prepare": "Projet non préparé pour la salle : relancez `install.ps1`",
      "empreinte-impossible": "Trop de fichiers d'IDE et de CI, ou fichiers trop gros, pour relever leurs empreintes : projet refusé.",
    } satisfies Record<OmoPrecheckReason, string>,
    /** Diagnostic « Sorties refusées (24 h) » (l.521) : raison du refus d'egress. */
    sortiesRefusees: {
      titre: "Sorties refusées (24 h)",
      raisons: {
        hote: "hôte non autorisé",
        port: "port autre que 443",
        "ip-litterale": "adresse IP écrite en clair",
        invalide: "nom d'hôte invalide",
        methode: "méthode autre que CONNECT",
      } satisfies Record<EgressRefusalReason, string>,
    },
    /** États de la salle (page de la salle, Diagnostic). */
    etats: {
      coupee: "Salle coupée",
      arretee: "Salle arrêtée",
      "en-relance": "Salle en relance",
      prete: "Salle prête",
      "demande-active": "Demande en cours",
      suspendue: "Salle suspendue",
    } satisfies Record<OmoEtatSalle, string>,
    /** §5.4 l.915 : aucune image chargée. */
    nonInstallee: "La Salle Oh My OpenAgent n'est pas installée sur ce poste.",
    /**
     * GET /api/omo/status en échec pour une autre raison qu'un 403 « salle-coupee » (erreur du serveur, flux coupé, redémarrage) :
     * l'état n'est pas connu, et la salle n'est PAS dite coupée (P3 ; relecture 2ter-vague-2). Aucun geste n'est promis.
     */
    statutIllisible: {
      libelle: "État de la salle illisible",
      raison: "L'état de la salle n'a pas pu être lu : le cockpit ne peut pas dire si une demande est en cours.",
    },
    /** Relance à neuf (omo.recreation) ; l.401 pour l'arrêt non confirmé. */
    recreation: {
      demandee: "Arrêt demandé",
      "arret-confirme": "Arrêt confirmé",
      "arret-non-confirme": "arrêt non confirmé",
      relancee: "Salle relancée à neuf",
    } satisfies Record<OmoRecreationEtat, string>,
    finDeDemande: "Demande terminée : la salle est relancée à neuf.",
    /** État git d'un projet préparé (Diagnostic). */
    git: {
      "lecture-seule": "historique git en lecture seule",
      inscriptible: "historique git inscriptible",
      absent: "sans historique git",
      inconnu: "état git inconnu",
    } satisfies Record<OmoProjectGitState, string>,
    /** Fichiers signalés (D-2b-37, §4.14.5 l.850). */
    signales: {
      "ide-ci": "Relisez ces fichiers avant de rouvrir ce projet dans votre éditeur.",
      programme: "à relire avant de lancer sur votre poste",
      "git-quarantaine":
        "Un historique git créé pendant la demande a été mis de côté ({chemin}). Relisez ces fichiers avant de rouvrir ce projet dans votre éditeur.",
    } satisfies Record<OmoSignale["genre"], string>,
    /**
     * Fin de demande (`omo.signales`, §4.14.5 l.850) : titre de la liste, mention d'une descente incomplète du cockpit (train de
     * V5, 2 ter), et, à part, nombre de fichiers relevés que la page n'affiche pas au-delà de sa borne (relecture 2ter-vague-5 :
     * ce n'est pas le cockpit qui n'a pas tout examiné). {n} : forme sans accord, juste pour 1 comme pour 50.
     */
    signalesFin: {
      titre: "Fichiers à relire",
      incomplet: "Liste incomplète : le cockpit n'a pas pu examiner tous les fichiers de la salle.",
      masques: "Liste abrégée pour l'affichage. Fichiers relevés non affichés ici : {n}.",
    },
    /** Diagnostic de la salle : présence seulement, jamais un contenu. */
    diagnostic: {
      authPresente: "Authentification de la salle : présente",
      authAbsente: "Authentification de la salle : absente",
      battementActif: "Battement du cockpit : actif",
      battementAbsent: "Battement du cockpit : absent",
      limiteAtteinte: "Dossier de travail trop grand pour vérifier chaque historique git : activation refusée.",
    },
    /** Marques d'origine et d'action dans la salle (§5.7.2, §5.7.4, §6 l.1066-1067). */
    marques: {
      ajouteParExtension: "ajouté par l'extension",
      dapresMarqueur: "d'après son marqueur",
      relanceExtension: "relance par l'extension (sans demande)",
      parExtension: "par l'extension",
      nonControle: "non contrôlé avant exécution",
      origineInconnue: "Message non écrit par vous (origine non identifiée)",
      reveilSansReponse: "Résultat déposé, lu à son prochain tour (sans appel d'IA)",
    },
  },
  partout: {
    /** Refus lu en mode Simple : la salle est réservée au mode Avancé. */
    refus: {
      "mode-avance": "La Salle OMO est réservée au mode Avancé.",
    } satisfies Record<Extract<OmoActivationRefusalCode, "mode-avance">, string>,
  },
} as const;

/** Phrase d'un refus d'activation (gabarit : {projet}, {plafondMaxUsd}, {liste} selon le code). */
export function phraseRefusActivation(code: OmoActivationRefusalCode): string {
  return code === "mode-avance" ? TEXTES.partout.refus[code] : TEXTES.avance.refus[code];
}

/** Phrase d'un arrêt de la salle (gabarit : {x} et {montant} pour plafond-cout). */
export function phraseArret(cause: OmoStopCause): string {
  return TEXTES.avance.arrets[cause];
}

export function phraseDetection(cause: OmoDetectionCause): string {
  return TEXTES.avance.detections[cause];
}

/** Libellé d'une catégorie d'interdit, pour le gabarit {categorie} de TEXTES.avance.interdits.message. */
export function libelleInterdit(categorie: OmoForbiddenCategory): string {
  return TEXTES.avance.interdits.categories[categorie];
}

export function phrasePrecontrole(raison: OmoPrecheckReason): string {
  return TEXTES.avance.precontrole[raison];
}

export function libelleSortieRefusee(raison: EgressRefusalReason): string {
  return TEXTES.avance.sortiesRefusees.raisons[raison];
}
