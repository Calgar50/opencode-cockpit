// Textes de la carte des agents en direct (spécification §2.1, §2.3, §5.4, §5.7.1 à §5.7.4, §5.9 ; plan d'exécution, fiche L5a) :
// libellés des signes, des états, des secteurs, des outils et des stations de la scène (neon-scene.ts), commandes, états vides,
// tableau et panneau du zoom 3 de la bande 2D (L5c), étiquette et lecteur de la démonstration enregistrée (L5d). Convention TEXTES de T0, contrôlée par textes.test.ts, avec
// « un sens par mot » : ni « pause », ni « relecture », « mode » seulement dans « mode Simple » ou « mode Avancé ».
// Honnêteté (P3, P12) : chaque libellé de signe nomme un signe que la scène ne dessine que sur un fait (neon-scene.test.ts) ;
// « terminé », jamais « réussi » ; la Salle OMO et l'extension ne sont nommées qu'en mode Avancé (salle réservée à ce mode).
// Vocabulaire du mode Simple (§5.7.4) : assistant, confier, en même temps, votre accord ; « agent » seulement en mode Avancé.
// Module pur (server/shared).
import type { NeonSign } from "./neon-palette.ts";
import type { NeonMarkedOrigin, NeonMode, NeonNodeState, NeonSector, NeonStationId, NeonToolCategory } from "./neon-scene.ts";

export const TEXTES = {
  simple: {
    /** Nom de la bande en mode Simple (« Carte des agents en direct » contient un mot du mode Avancé). */
    titre: "Travail en direct",
    /** §5.4 : bande sans délégation. */
    resume: "Une seule IA travaille sur cette demande.",
    /** §5.7.4 : démonstration proposée en mode Simple. */
    demonstration: "Voir une démonstration : deux assistants en même temps",
    /**
     * §5.9, décision n° 4 et P3 : la démonstration dessine une délégation, refusée en mode Simple ; suivie dans le lecteur (L5d) de
     * l'avis Simple de delegation-texts.ts, « En mode Simple, l'IA ne délègue pas : elle continue seule. ».
     */
    demonstrationAvancee: "Enregistrée en mode Avancé.",
    /** Délégations enregistrées avant le passage en mode Simple : comptées, non dessinées ; la liste des acteurs les montre. */
    travailConfieHorsCarte: "Du travail a été confié à d'autres assistants : la liste ci-dessous le montre.",
    /** Station « Carnet partagé et plan », toujours vide hors de la Salle OMO. */
    carnetVide: "Vide pour cette conversation.",
  },
  avance: {
    /** §2.1 : nom de la bande 2D. */
    titre: "Carte des agents en direct",
    carnetVide: "Vide hors de la Salle OMO.",
    /** §5.7.2, cas 4 à 6 dans la Salle OMO. */
    origines: {
      "reveil-sans-reponse": "Résultat déposé, lu à son prochain tour",
      "relance-extension": "Relance par l'extension (sans demande)",
      "interne-extension": "Message interne de l'extension, d'après son marqueur",
    },
    signes: {
      /** §5.7.1 : action de l'extension sans demande. */
      extension: "Par l'extension",
    },
    /** §5.7.4 : marque de toute action de l'extension sans demande. */
    nonControle: "Non contrôlé avant exécution",
  },
  partout: {
    commandes: {
      figer: "Figer l'affichage (le travail continue)",
      reprendre: "Reprendre l'affichage en direct",
      tableau: "Tableau",
      demonstration: "Voir une démonstration",
      afficher: "Afficher la carte",
      replier: "Replier la carte",
    },
    /** §5.7.4 : file d'affichage de plus de 2 s vidée d'un coup. */
    rattrape: "Affichage rattrapé",
    /** §5.9 : étiquette de la démonstration (L5d). */
    demonstrationEnregistree: "Démonstration enregistrée : aucune IA n'est appelée",
    /** Lecteur pas à pas de la démonstration (L5d) : un moment = une coupure nette de la scène (moments() de neon-scene.ts). */
    lecteur: {
      /** Démonstration p1 : deux délégations lancées par une même réponse, capture réelle. */
      titre: "Deux assistants en même temps",
      moment: "Moment {n} / {total}",
      /** Valeur dite du curseur des moments. */
      momentAccessible: "Moment {n} sur {total}, {duree} depuis le début",
      depuisDebut: "{duree} depuis le début",
      precedent: "Moment précédent",
      suivant: "Moment suivant",
      recommencer: "Recommencer",
    },
    stations: {
      vous: "Vous",
      copilot: "GitHub Copilot",
      carnet: "Carnet partagé et plan",
    },
    secteurs: {
      planifier: "Planifier",
      chercher: "Chercher",
      conseiller: "Conseiller",
      executer: "Exécuter",
      verifier: "Vérifier",
      autres: "Autres",
    },
    /** Anneau d'outils du zoom 3 (§5.7.4). */
    outils: {
      lire: "Lire",
      chercher: "Chercher",
      modifier: "Modifier",
      commande: "Commande",
      confier: "Confier",
      question: "Question",
      autres: "Autres outils",
    },
    /** §2.3, états. */
    etats: {
      "pas-commence": "pas encore commencé",
      travaille: "travaille",
      "attente-accord": "en attente de votre accord",
      termine: "terminé",
      echec: "échec",
      arrete: "arrêté",
    },
    /** Légende des signes (§5.7.1) ; l'extension est nommée en mode Avancé seulement. */
    signes: {
      demande: "Votre demande",
      preparation: "Prépare une délégation",
      consigne: "Consigne confiée",
      resultat: "Résultat rendu",
      attente: "En attente de votre accord",
      auto: "Autorisé automatiquement",
      refus: "Refusé automatiquement",
      appel: "Appel d'IA vers GitHub Copilot",
      travaille: "Travaille",
      termine: "Terminé",
      echec: "Échec",
      arret: "Arrêté",
    },
    enMemeTemps: "en même temps",
    /** §5.7.2, cas 2, 6 (conversation principale) et 7. */
    origines: {
      cockpit: "Recopié par le cockpit",
      "interne-opencode": "Message ajouté par opencode",
      "origine-inconnue": "Message non écrit par vous (origine non identifiée)",
    },
    /** Panneau du zoom 3 (§5.7.4). */
    panneau: {
      consigne: "Consigne reçue",
      actions: "Ce qu'il a fait",
      resultat: "Résultat rendu",
      reponse: "Réponse rédigée",
    },
    /** Tuiles de fichiers du zoom 3 : contour bleu, plein rose, barré. */
    tuiles: {
      lu: "lu",
      modifie: "modifié",
      refuse: "refusé",
      enCours: "en cours",
      enPlus: "+{n}",
    },
    assistantConversation: "Assistant de la conversation",
    taches: "Tâches : {faites}/{total}",
    memoireResumee: "Mémoire résumée",
    tentative: "nouvelle tentative ({n})",
    /** §5.7.3 : donnée non durable absente (trou étiqueté). */
    nonEnregistre: "non enregistré",
    /** Nom accessible du bouton d'un assistant sur la carte (§5.7.4 : un vrai bouton par assistant). */
    bouton: "{nom}, {etat}",
    /** Assistant délégué dont le nom n'est pas enregistré (P12 : un inconnu est dit inconnu). */
    assistantInconnu: "Assistant non identifié",
    /** [Tableau] de la bande 2D (L5c) : une ligne par assistant dessiné ; la légende du tableau est le titre de la bande. */
    tableau: {
      assistant: "Assistant",
      secteur: "Secteur",
      etat: "État",
      depuis: "Depuis",
      carte: "Sur la carte",
    },
    /** Panneau du zoom 3 (L5c) : texte relu dans la conversation mais illisible (message absent, proxy injoignable). */
    texteIndisponible: "Texte indisponible.",
  },
};

/** Remplit un gabarit « {nom} » ; un nom absent des valeurs garde son gabarit. */
export function remplir(gabarit: string, valeurs: Readonly<Record<string, string | number>>): string {
  return gabarit.replace(/\{(\w+)\}/g, (match: string, nom: string) => (Object.hasOwn(valeurs, nom) ? String(valeurs[nom]) : match));
}

export function libelleEtat(etat: NeonNodeState): string {
  return TEXTES.partout.etats[etat];
}

export function libelleSecteur(secteur: NeonSector): string {
  return TEXTES.partout.secteurs[secteur];
}

export function libelleOutil(outil: NeonToolCategory | "autres"): string {
  return TEXTES.partout.outils[outil];
}

export function libelleStation(station: NeonStationId): string {
  return TEXTES.partout.stations[station];
}

/** Légende d'un signe ; null pour l'extension en mode Simple (Salle OMO réservée au mode Avancé). */
export function libelleSigne(signe: NeonSign, mode: NeonMode): string | null {
  if (signe === "extension") return mode === "avance" ? TEXTES.avance.signes.extension : null;
  return TEXTES.partout.signes[signe];
}

/** Libellé d'une marque d'origine ; null pour une origine de la Salle OMO en mode Simple. */
export function libelleOrigine(origine: NeonMarkedOrigin, mode: NeonMode): string | null {
  switch (origine) {
    case "reveil-sans-reponse":
    case "relance-extension":
    case "interne-extension":
      return mode === "avance" ? TEXTES.avance.origines[origine] : null;
    default:
      return TEXTES.partout.origines[origine];
  }
}

export function titreBande(mode: NeonMode): string {
  return mode === "avance" ? TEXTES.avance.titre : TEXTES.simple.titre;
}

export function carnetVide(mode: NeonMode): string {
  return mode === "avance" ? TEXTES.avance.carnetVide : TEXTES.simple.carnetVide;
}

/** Nom accessible du bouton d'un assistant : son nom (ou « Assistant de la conversation ») et son état. */
export function libelleBouton(nom: string | null, etat: NeonNodeState): string {
  return remplir(TEXTES.partout.bouton, { nom: nom ?? TEXTES.partout.assistantConversation, etat: libelleEtat(etat) });
}
